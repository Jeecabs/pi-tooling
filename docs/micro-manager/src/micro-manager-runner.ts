import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ModelsApiStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TextContent,
  StringEnum,
  uuidv7,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { Type, type Static } from "typebox";
import { isMicroManagerSeverity, normalizeMicroManagerText } from "./message-format.ts";
import { MicroManagerEmissionGuard } from "./emission-guard.ts";
import type { MicroManagerNote, MicroManagerRuntimeStats } from "./types.ts";

const MAX_TOOL_CALLS_PER_RESPONSE = 8;

const reportSchema = Type.Object({
  note: Type.String({ minLength: 1, description: "One concrete, terse, actionable note for the driving agent." }),
  severity: Type.Optional(
    StringEnum(["nit", "concern", "blocker"] as const, {
      description: "How strongly the driving agent should weigh this note.",
    }),
  ),
});
type ReportArguments = Static<typeof reportSchema>;

const reportTool: Tool<typeof reportSchema> = {
  name: "report",
  description: "Send one concrete, terse review note to the driving agent. Stay silent when nothing matters.",
  parameters: reportSchema,
};

export interface MicroManagerCompletionClient {
  complete(
    model: Model<any>,
    context: Context,
    options?: ModelsApiStreamOptions<any>,
  ): Promise<AssistantMessage>;
}

export interface MicroManagerRunnerOptions {
  name: string;
  model: Model<any>;
  thinking: ThinkingLevel;
  systemPrompt: string;
  tools: AgentTool[];
  complete: MicroManagerCompletionClient["complete"];
  timeoutMs: number;
  maxOutputTokens: number;
  maxToolRounds: number;
  maxContextChars: number;
  maxAttempts: number;
  onReport(note: MicroManagerNote): void;
  onStateChange?(): void;
  retryDelayMs?: number;
}

export class MicroManagerRunner {
  readonly #complete: MicroManagerCompletionClient["complete"];
  readonly #guard = new MicroManagerEmissionGuard();
  readonly #maxAttempts: number;
  readonly #maxContextChars: number;
  readonly #maxOutputTokens: number;
  readonly #maxToolRounds: number;
  readonly #model: Model<any>;
  readonly #name: string;
  readonly #onReport: (note: MicroManagerNote) => void;
  readonly #onStateChange: (() => void) | undefined;
  readonly #retryDelayMs: number;
  readonly #sessionId = uuidv7();
  readonly #systemPrompt: string;
  readonly #thinking: ThinkingLevel;
  readonly #timeoutMs: number;
  readonly #toolMap: Map<string, AgentTool>;
  readonly #toolResultChars: number;
  readonly #tools: Tool[];
  #busy = false;
  #disposed = false;
  #epoch = 0;
  #iterationAbort: AbortController | undefined;
  #messages: Message[] = [];
  #pending: string[] = [];
  #stats: MicroManagerRuntimeStats;

  constructor(options: MicroManagerRunnerOptions) {
    this.#name = options.name;
    this.#model = options.model;
    this.#thinking = options.thinking;
    this.#systemPrompt = options.systemPrompt;
    this.#toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#tools = [reportTool, ...options.tools];
    this.#complete = options.complete;
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#maxToolRounds = options.maxToolRounds;
    this.#maxContextChars = options.maxContextChars;
    this.#maxAttempts = options.maxAttempts;
    this.#retryDelayMs = options.retryDelayMs ?? 500;
    this.#toolResultChars = Math.max(
      500,
      Math.min(
        8_000,
        Math.floor(options.maxContextChars / (2 * Math.max(1, options.maxToolRounds) * MAX_TOOL_CALLS_PER_RESPONSE)),
      ),
    );
    this.#onReport = options.onReport;
    this.#onStateChange = options.onStateChange;
    this.#stats = {
      name: options.name,
      state: "running",
      model: options.model,
      backlog: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
  }

  get stats(): MicroManagerRuntimeStats {
    return { ...this.#stats, backlog: this.backlog };
  }

  get backlog(): number {
    return this.#pending.length + (this.#busy ? 1 : 0);
  }

  dump(): string {
    return this.#messages
      .map((message) => {
        if (message.role === "user") return `## Update\n\n${textContent(message.content)}`;
        if (message.role === "assistant") return `## The Micro Manager\n\n${textContent(message.content) || "(tool calls or silence)"}`;
        return `## Tool: ${message.toolName}${message.isError ? " (error)" : ""}\n\n${textContent(message.content)}`;
      })
      .join("\n\n");
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (!this.#disposed && this.backlog > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
    return this.backlog === 0;
  }

  enqueue(update: string): void {
    if (this.#disposed || !update.trim()) return;
    if (this.#pending.length >= 5) {
      const last = this.#pending.length - 1;
      this.#pending[last] = `${this.#pending[last]}\n\n${update}`;
    } else {
      this.#pending.push(update);
    }
    this.#notifyState();
    void this.#drain();
  }

  reset(): void {
    if (this.#disposed) return;
    this.#epoch++;
    this.#iterationAbort?.abort("micro-manager reset");
    this.#pending = [];
    this.#messages = [];
    this.#guard.reset();
    this.#stats.state = "running";
    delete this.#stats.lastError;
    this.#notifyState();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch++;
    this.#iterationAbort?.abort("micro-manager disposed");
    this.#pending = [];
    this.#stats.state = "paused";
    this.#notifyState();
  }

  async #drain(): Promise<void> {
    if (this.#busy || this.#disposed) return;
    this.#busy = true;
    this.#notifyState();
    try {
      while (!this.#disposed && this.#pending.length > 0) {
        const update = this.#pending.splice(0).join("\n\n");
        const epoch = this.#epoch;
        const abort = new AbortController();
        this.#iterationAbort = abort;
        try {
          await this.#reviewWithRetries(update, abort.signal, epoch);
          if (epoch !== this.#epoch) continue;
          this.#stats.state = "running";
          delete this.#stats.lastError;
        } catch (error) {
          if (epoch !== this.#epoch || abort.signal.aborted || this.#disposed) continue;
          this.#stats.state = "error";
          this.#stats.lastError = errorMessage(error);
        } finally {
          if (this.#iterationAbort === abort) this.#iterationAbort = undefined;
          this.#notifyState();
        }
      }
    } finally {
      this.#busy = false;
      this.#notifyState();
    }
  }

  async #reviewWithRetries(update: string, parentSignal: AbortSignal, epoch: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (parentSignal.aborted || epoch !== this.#epoch) return;
      const snapshot = this.#messages;
      const snapshotLength = snapshot.length;
      try {
        await this.#review(update, parentSignal, epoch);
        return;
      } catch (error) {
        lastError = error;
        if (parentSignal.aborted || epoch !== this.#epoch) throw error;
        this.#messages.length = this.#messages === snapshot ? snapshotLength : 0;
        if (attempt >= this.#maxAttempts) throw error;
        await delay(this.#retryDelayMs, parentSignal);
      }
    }
    throw lastError;
  }

  async #review(update: string, parentSignal: AbortSignal, epoch: number): Promise<void> {
    const boundedUpdate = boundUpdate(update, Math.max(1_000, Math.floor(this.#maxContextChars / 2)));
    const updateMessage: Message = {
      role: "user",
      content: [{ type: "text", text: boundedUpdate }],
      timestamp: Date.now(),
    };
    if (contextChars([...this.#messages, updateMessage]) > this.#maxContextChars) {
      this.#messages = [];
      this.#guard.reset();
    }
    this.#guard.beginUpdate();
    this.#messages.push(updateMessage);

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("micro-manager update timed out"), this.#timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([parentSignal, timeout.signal]);
    try {
      for (let round = 0; round <= this.#maxToolRounds; round++) {
        signal.throwIfAborted();
        if (epoch !== this.#epoch || contextChars(this.#messages) > this.#maxContextChars) return;
        const response = await this.#complete(
          this.#model,
          { systemPrompt: this.#systemPrompt, messages: [...this.#messages], tools: this.#tools },
          this.#completionOptions(signal),
        );
        signal.throwIfAborted();
        if (epoch !== this.#epoch) return;
        this.#recordUsage(response);
        this.#messages.push(response);

        if (response.stopReason === "aborted") {
          signal.throwIfAborted();
          throw new Error(response.errorMessage || "micro-manager provider aborted the request");
        }
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage || "micro-manager provider returned an error");
        }
        if (response.stopReason === "length") throw new Error("micro-manager response reached its output-token limit");

        const calls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
        if (calls.length === 0) return;
        const toolLimitReached = round >= this.#maxToolRounds;
        const results = await Promise.all(
          calls.map((call, index) => {
            if (index >= MAX_TOOL_CALLS_PER_RESPONSE && call.name !== "report") {
              return {
                message: errorToolResult(call, "Micro-manager tool-call limit reached for this response"),
                reportHandled: false,
              };
            }
            if (toolLimitReached && call.name !== "report") {
              return {
                message: errorToolResult(call, "Micro-manager read-only tool-round limit reached"),
                reportHandled: false,
              };
            }
            return this.#executeToolCall(call, signal);
          }),
        );
        signal.throwIfAborted();
        if (epoch !== this.#epoch) return;
        this.#messages.push(...results.map((entry) => entry.message));
        if (results.some((entry) => entry.reportHandled) || toolLimitReached) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #completionOptions(signal: AbortSignal): ModelsApiStreamOptions<any> {
    const thinking = clampThinkingLevel(this.#model, this.#thinking);
    return {
      signal,
      sessionId: this.#sessionId,
      cacheRetention: "none",
      maxTokens: Math.min(this.#maxOutputTokens, this.#model.maxTokens),
      maxRetries: 0,
      timeoutMs: this.#timeoutMs,
      ...(thinking === "off" ? {} : { reasoning: thinking }),
    };
  }

  async #executeToolCall(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ message: ToolResultMessage; reportHandled: boolean }> {
    if (call.name === "report") return this.#executeReport(call);
    const tool = this.#toolMap.get(call.name);
    if (!tool) return { message: errorToolResult(call, `Tool ${call.name} is not available`), reportHandled: false };

    try {
      const prepared = tool.prepareArguments
        ? { ...call, arguments: tool.prepareArguments(call.arguments) as Record<string, unknown> }
        : call;
      const args = validateToolArguments(tool, prepared);
      const result = await tool.execute(call.id, args, signal);
      return {
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: boundToolContent(result.content ?? [], this.#toolResultChars),
          ...(result.usage ? { usage: result.usage } : {}),
          isError: false,
          timestamp: Date.now(),
        },
        reportHandled: false,
      };
    } catch (error) {
      return { message: errorToolResult(call, errorMessage(error)), reportHandled: false };
    }
  }

  #executeReport(call: ToolCall): { message: ToolResultMessage; reportHandled: boolean } {
    try {
      const args = validateToolArguments(reportTool, call) as ReportArguments;
      const note = normalizeMicroManagerText(args.note);
      const severity = isMicroManagerSeverity(args.severity) ? args.severity : undefined;
      if (note && this.#guard.accept(note)) {
        const report: MicroManagerNote = { note };
        if (severity) report.severity = severity;
        if (this.#name !== "default") report.manager = this.#name;
        this.#onReport(report);
      }
      return { message: textToolResult(call, "Recorded."), reportHandled: true };
    } catch (error) {
      return { message: errorToolResult(call, errorMessage(error)), reportHandled: true };
    }
  }

  #recordUsage(message: AssistantMessage): void {
    this.#stats.turns++;
    this.#stats.inputTokens += message.usage.input;
    this.#stats.outputTokens += message.usage.output;
    this.#stats.cost += message.usage.cost.total;
  }

  #notifyState(): void {
    this.#stats.backlog = this.backlog;
    this.#onStateChange?.();
  }
}

function textToolResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function errorToolResult(call: ToolCall, text: string): ToolResultMessage {
  const bounded = text.length > 2_000 ? `${text.slice(0, 1_976)}\n[error truncated]` : text;
  return { ...textToolResult(call, bounded), isError: true };
}

function boundUpdate(update: string, maxChars: number): string {
  if (update.length <= maxChars) return update;
  const suffix = "\n\n[earlier update content truncated]";
  return `${update.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function boundToolContent(
  content: readonly (TextContent | ImageContent)[],
  maxChars: number,
): TextContent[] {
  const parts: string[] = [];
  let remaining = maxChars;
  for (const block of content) {
    if (remaining <= 0) break;
    const text = block.type === "text" ? block.text : "[image omitted from micro-manager context]";
    if (text.length <= remaining) {
      parts.push(text);
      remaining -= text.length;
      continue;
    }
    parts.push(`${text.slice(0, Math.max(0, remaining - 24))}\n[tool output truncated]`);
    remaining = 0;
  }
  return parts.length > 0 ? [{ type: "text", text: parts.join("\n") }] : [];
}

function contextChars(messages: readonly Message[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function textContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error("micro-manager aborted"));
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
