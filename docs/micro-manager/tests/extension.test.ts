import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMicroManagerExtension } from "../src/extension.ts";
import type { MicroManagerConfiguration, MicroManagerSeverity } from "../src/types.ts";

const MODEL: Model<"openai-responses"> = {
  id: "primary-model",
  name: "Primary",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};

function configuration(enabled = true): MicroManagerConfiguration {
  return {
    settings: {
      enabled,
      thinking: "low",
      tools: ["read", "grep", "find", "ls"],
      timeoutMs: 5_000,
      maxInputChars: 20_000,
      maxOutputTokens: 512,
      maxToolRounds: 2,
      maxContextChars: 50_000,
      maxAttempts: 1,
      immuneTurns: 3,
    },
    managers: [],
    priorityBlocks: [],
    sources: ["/test/MICRO_MANAGER.yml"],
    errors: [],
    projectConfigDetected: false,
    projectConfigLoaded: false,
  };
}

function microManagerResponse(note: string, severity: MicroManagerSeverity): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `report-${severity}`,
        name: "report",
        arguments: { note, severity },
      },
    ],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

async function createHarness(options: {
  enabled?: boolean;
  idle?: boolean;
  response?: AssistantMessage;
  responses?: AssistantMessage[];
  projectCandidate?: boolean;
  savedTrust?: boolean | null;
  confirmTrust?: boolean;
  mode?: "tui" | "print" | "json";
  completeDelayMs?: number;
} = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const flags = new Map<string, any>();
  const renderers = new Map<string, any>();
  const sendCalls: Array<{ message: any; options: any }> = [];
  const appendCalls: Array<{ customType: string; data: any }> = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const branch: any[] = [
    { type: "message", id: "u1", message: { role: "user", content: "Implement it." } },
    {
      type: "message",
      id: "a1",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented." }] },
    },
  ];
  let idle = options.idle ?? true;
  let savedTrust = options.savedTrust ?? null;
  let discoveryIncludeProject: boolean | undefined;
  let completeCalls = 0;
  const queuedResponses = [...(options.responses ?? [])];

  const pi = Object.assign({} as ExtensionAPI, {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerFlag(name: string, flag: any) {
      flags.set(name, flag);
    },
    getFlag() {
      return false;
    },
    registerMessageRenderer(name: string, renderer: any) {
      renderers.set(name, renderer);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    sendMessage(message: any, sendOptions?: any) {
      sendCalls.push({ message, options: sendOptions });
    },
    appendEntry(customType: string, data: any) {
      appendCalls.push({ customType, data });
    },
  });

  const ctx = {
    cwd: "/test/project",
    mode: options.mode ?? "tui",
    hasUI: (options.mode ?? "tui") === "tui",
    model: MODEL,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      confirm: async () => options.confirmTrust ?? false,
      editor: async () => undefined,
    },
    sessionManager: {
      getBranch: () => branch,
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [MODEL],
      complete: async () => {
        completeCalls++;
        if (options.completeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.completeDelayMs));
        return queuedResponses.shift() ?? options.response ?? microManagerResponse("Check the focused test.", "concern");
      },
    },
    isProjectTrusted: () => true,
    isIdle: () => idle,
  };

  registerMicroManagerExtension(pi, {
    discoverConfig: async (discovery) => {
      discoveryIncludeProject = discovery.includeProject;
      return configuration(options.enabled ?? true);
    },
    trust: {
      hasStandardResources: () => false,
      getSavedDecision: () => savedTrust,
      rememberDecision: (_cwd, decision) => {
        savedTrust = decision;
      },
      hasProjectCandidate: async () => options.projectCandidate ?? false,
    },
  });
  await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

  return {
    appendCalls,
    branch,
    commands,
    ctx,
    discoveryIncludeProject: () => discoveryIncludeProject,
    flags,
    handlers,
    notifications,
    renderers,
    sendCalls,
    setIdle(value: boolean) {
      idle = value;
    },
    completeCalls: () => completeCalls,
    savedTrust: () => savedTrust,
    statuses,
  };
}

test("registers the complete Micro Manager public surface", async () => {
  const h = await createHarness();
  assert.deepEqual([...h.commands.keys()], ["micro-manager"]);
  assert.deepEqual([...h.flags.keys()], ["micro-manager"]);
  assert.deepEqual([...h.renderers.keys()], ["micro-manager"]);
});

test("reviews turn asynchronously and preserves a late concern without waking the agent", async () => {
  const h = await createHarness({ response: microManagerResponse("Escape <unsafe> output.", "concern") });
  const result = h.handlers.get("turn_end")?.[0]?.({ turnIndex: 1 }, h.ctx);
  assert.equal(result, undefined);
  await waitFor(() => h.sendCalls.length === 1);

  assert.equal(h.sendCalls[0]?.options, undefined);
  assert.match(h.sendCalls[0]?.message.content ?? "", /&lt;unsafe&gt;/);
  assert.deepEqual(h.sendCalls[0]?.message.details.notes[0], {
    note: "Escape <unsafe> output.",
    severity: "concern",
    model: "openai/primary-model",
  });
});

test("steers a blocker into a live primary run", async () => {
  const h = await createHarness({ idle: false, response: microManagerResponse("The migration is deleting live data.", "blocker") });
  h.handlers.get("turn_end")?.[0]?.({ turnIndex: 2 }, h.ctx);
  await waitFor(() => h.sendCalls.length === 1);

  assert.deepEqual(h.sendCalls[0]?.options, { deliverAs: "steer", triggerTurn: true });
});

test("counts interruption immunity across agent runs whose turn indexes restart", async () => {
  const notes = ["first", "second", "third", "fourth", "fifth"].map((note) =>
    microManagerResponse(`${note} blocker`, "blocker"),
  );
  const h = await createHarness({ idle: false, responses: notes });

  for (let index = 0; index < notes.length; index++) {
    if (index > 0) {
      h.branch.push({
        type: "message",
        id: `a-immunity-${index}`,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `step ${index}` }] },
      });
    }
    h.handlers.get("turn_end")?.[0]?.({ turnIndex: 0 }, h.ctx);
    await waitFor(() => h.sendCalls.length === index + 1);
  }

  assert.deepEqual(h.sendCalls.map((entry) => entry.options), [
    { deliverAs: "steer", triggerTurn: true },
    { deliverAs: "followUp" },
    { deliverAs: "followUp" },
    { deliverAs: "followUp" },
    { deliverAs: "steer", triggerTurn: true },
  ]);
});

test("manual enable seeds existing history and reviews only later entries", async () => {
  const h = await createHarness({ enabled: false });
  await h.commands.get("micro-manager").handler("on", h.ctx);
  h.handlers.get("turn_end")?.[0]?.({ turnIndex: 1 }, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.completeCalls(), 0);

  h.branch.push({
    type: "message",
    id: "a2",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "New work." }] },
  });
  h.handlers.get("turn_end")?.[0]?.({ turnIndex: 2 }, h.ctx);
  await waitFor(() => h.completeCalls() === 1);
});

test("buffers active JSON reports until settlement without starting a hidden turn", async () => {
  const h = await createHarness({
    mode: "json",
    idle: false,
    response: microManagerResponse("The final output is invalid.", "blocker"),
  });
  h.handlers.get("turn_end")?.[0]?.({ turnIndex: 1 }, h.ctx);
  await waitFor(() => h.completeCalls() === 1);
  assert.equal(h.sendCalls.length, 0);

  await h.handlers.get("agent_settled")?.[0]?.({}, h.ctx);
  assert.equal(h.sendCalls.length, 1);
  assert.equal(h.sendCalls[0]?.options, undefined);
});

test("headless settlement waits for final review without replacing print output", async () => {
  const h = await createHarness({
    mode: "print",
    completeDelayMs: 25,
    response: microManagerResponse("The final output is invalid.", "blocker"),
  });
  h.handlers.get("turn_end")?.[0]?.({ turnIndex: 1 }, h.ctx);
  const started = Date.now();
  await h.handlers.get("agent_settled")?.[0]?.({}, h.ctx);

  assert.ok(Date.now() - started >= 15);
  assert.equal(h.sendCalls.length, 0);
  assert.equal(h.appendCalls.length, 1);
  assert.equal(h.appendCalls[0]?.customType, "micro-manager-report");
  assert.equal(h.appendCalls[0]?.data.details.notes[0]?.note, "The final output is invalid.");
});

test("asks before loading root project config when Pi otherwise auto-trusts the directory", async () => {
  const h = await createHarness({ projectCandidate: true, savedTrust: null, confirmTrust: true });
  assert.equal(h.savedTrust(), true);
  assert.equal(h.discoveryIncludeProject(), true);
  assert.ok(h.notifications.some((entry) => entry.message.includes("Project trust saved")));
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
