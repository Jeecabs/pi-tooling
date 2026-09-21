import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  microManagerMessageDetails,
  formatMicroManagerBatchContent,
  isInterruptingSeverity,
} from "./message-format.ts";
import { MicroManagerRunner, type MicroManagerRunnerOptions } from "./micro-manager-runner.ts";
import {
  discoverMicroManagerConfiguration,
  hasProjectMicroManagerCandidate,
  type MicroManagerConfigDiscoveryOptions,
} from "./config.ts";
import { buildMicroManagerSystemPrompt } from "./prompt.ts";
import { renderMicroManagerMessage } from "./renderer.ts";
import { TranscriptCursor } from "./transcript.ts";
import { createWorkspaceTools } from "./workspace-tools.ts";
import type {
  MicroManagerConfiguration,
  MicroManagerDefinition,
  MicroManagerNote,
  MicroManagerRuntimeStats,
} from "./types.ts";

const STATUS_KEY = "micro-manager";
const COMMAND_USAGE = "/micro-manager [on|off|status|reload|dump|config]";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface ProjectTrustAccess {
  hasStandardResources(cwd: string): boolean;
  getSavedDecision(cwd: string): boolean | null;
  rememberDecision(cwd: string, trusted: boolean): void;
  hasProjectCandidate(cwd: string, configDirName: string): Promise<boolean>;
}

export interface MicroManagerExtensionDependencies {
  discoverConfig?(options: MicroManagerConfigDiscoveryOptions): Promise<MicroManagerConfiguration>;
  createRunner?(options: MicroManagerRunnerOptions): MicroManagerRunner;
  trust?: ProjectTrustAccess;
}

export function registerMicroManagerExtension(
  pi: ExtensionAPI,
  dependencies: MicroManagerExtensionDependencies = {},
): void {
  const agentDir = getAgentDir();
  const trustStore = dependencies.trust ? undefined : new ProjectTrustStore(agentDir);
  const trust: ProjectTrustAccess =
    dependencies.trust ??
    {
      hasStandardResources: hasTrustRequiringProjectResources,
      getSavedDecision: (cwd) => trustStore!.get(cwd),
      rememberDecision: (cwd, decision) => trustStore!.set(cwd, decision),
      hasProjectCandidate: hasProjectMicroManagerCandidate,
    };
  const discoverConfig = dependencies.discoverConfig ?? discoverMicroManagerConfiguration;
  const createRunner = dependencies.createRunner ?? ((options: MicroManagerRunnerOptions) => new MicroManagerRunner(options));
  const cursor = new TranscriptCursor();
  let configuration: MicroManagerConfiguration | undefined;
  let runners: MicroManagerRunner[] = [];
  let inactiveStats: MicroManagerRuntimeStats[] = [];
  let sessionOverride: boolean | undefined;
  let sessionEpoch = 0;
  let completedTurns = 0;
  let immuneTurnStart: number | undefined;
  let deliveredNotes = 0;
  let pendingHeadlessNotes: MicroManagerNote[] = [];
  let activeContext: ExtensionContext | undefined;
  let blinkTimer: ReturnType<typeof setInterval> | undefined;
  let blinkFrame = 0;

  pi.registerFlag("micro-manager", {
    description: "Enable The Micro Manager for this process",
    type: "boolean",
    default: false,
  });

  pi.registerMessageRenderer("micro-manager", renderMicroManagerMessage);

  pi.registerCommand("micro-manager", {
    description: "Inspect or control The Micro Manager",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off", "status", "reload", "dump", "config"];
      const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        outputCommandText(ctx, statusText(), "info");
        return;
      }
      if (action === "on") {
        sessionOverride = true;
        rebuildRunners(ctx, true);
        outputCommandText(
          ctx,
          runners.length > 0 ? "micro-manager enabled" : "micro-manager enabled, but no model resolved",
          runners.length > 0 ? "info" : "warning",
        );
        return;
      }
      if (action === "off") {
        sessionOverride = false;
        stopRunners();
        refreshStatus(ctx);
        outputCommandText(ctx, "micro-manager disabled for this session", "info");
        return;
      }
      if (action === "reload") {
        await loadConfiguration(ctx, true);
        rebuildRunners(ctx, true);
        outputCommandText(
          ctx,
          configuration?.errors.length ? "micro-manager config reloaded with warnings" : "micro-manager config reloaded",
          configuration?.errors.length ? "warning" : "info",
        );
        return;
      }
      if (action === "dump") {
        const dump = runners.map((runner) => `# ${runner.stats.name}\n\n${runner.dump() || "(empty)"}`).join("\n\n---\n\n");
        if (ctx.mode === "tui") {
          await ctx.ui.editor("The Micro Manager transcript", dump || "(micro-manager transcript is empty)");
        } else {
          outputCommandText(ctx, dump || "micro-manager transcript is empty", "info");
        }
        return;
      }
      if (action === "config" || action === "configure") {
        outputCommandText(ctx, configGuidance(ctx), "info");
        return;
      }
      outputCommandText(ctx, `Usage: ${COMMAND_USAGE}`, "warning");
    },
  });

  pi.on("project_trust", async (event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return { trusted: "undecided" as const };
    try {
      if (trust.getSavedDecision(event.cwd) !== null) return { trusted: "undecided" as const };
      if (!(await trust.hasProjectCandidate(event.cwd, CONFIG_DIR_NAME))) {
        return { trusted: "undecided" as const };
      }
    } catch {
      return { trusted: "undecided" as const };
    }
    const confirmed = await confirmProjectTrust(event.cwd, (title, message) => ctx.ui.confirm(title, message));
    return confirmed
      ? { trusted: "yes" as const, remember: true }
      : { trusted: "no" as const, remember: true };
  });

  pi.on("session_start", async (event, ctx) => {
    const expectedEpoch = ++sessionEpoch;
    activeContext = ctx;
    sessionOverride = pi.getFlag("micro-manager") === true ? true : undefined;
    completedTurns = 0;
    immuneTurnStart = undefined;
    deliveredNotes = 0;
    pendingHeadlessNotes = [];
    cursor.reset();
    if (!(await loadConfiguration(ctx, true, expectedEpoch))) return;
    rebuildRunners(ctx, event.reason === "reload");
  });

  pi.on("turn_end", (_event, ctx) => {
    completedTurns++;
    if (runners.length === 0 || !isEnabled()) return;
    const delta = cursor.next(ctx.sessionManager.getBranch(), configuration?.settings.maxInputChars ?? 24_000);
    if (!delta) return;
    if (delta.reset) for (const runner of runners) runner.reset();
    for (const runner of runners) runner.enqueue(delta.text);
    refreshStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if ((ctx.mode !== "print" && ctx.mode !== "json") || runners.length === 0) return;
    const timeoutMs = Math.min(
      60_000,
      (configuration?.settings.timeoutMs ?? 30_000) * (configuration?.settings.maxAttempts ?? 1),
    );
    await Promise.all(runners.map((runner) => runner.waitForIdle(timeoutMs)));
    flushHeadlessNotes(ctx);
  });

  pi.on("session_compact", (_event, ctx) => resetConversation(ctx));
  pi.on("session_tree", (_event, ctx) => resetConversation(ctx));

  pi.on("model_select", (_event, ctx) => {
    if (!isEnabled() || !usesPrimaryModel()) return;
    rebuildRunners(ctx, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionEpoch++;
    activeContext = undefined;
    pendingHeadlessNotes = [];
    stopRunners();
    cursor.reset();
    stopBlink();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  function outputCommandText(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(text, type);
      return;
    }
    pi.sendMessage({ customType: "micro-manager-status", content: text, display: true });
  }

  function resetConversation(ctx: ExtensionContext): void {
    cursor.reset();
    pendingHeadlessNotes = [];
    for (const runner of runners) runner.reset();
    immuneTurnStart = undefined;
    refreshStatus(ctx);
  }

  async function loadConfiguration(
    ctx: ExtensionContext,
    requestTrust: boolean,
    expectedEpoch?: number,
  ): Promise<boolean> {
    const includeProject = await resolveProjectTrust(ctx, requestTrust);
    if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch) return false;
    const next = await discoverConfig({
      cwd: ctx.cwd,
      agentDir,
      includeProject,
      configDirName: CONFIG_DIR_NAME,
    });
    if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch) return false;
    configuration = next;
    if (configuration.errors.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`micro-manager config warning: ${configuration.errors[0]}`, "warning");
    }
    return true;
  }

  async function resolveProjectTrust(ctx: ExtensionContext, requestTrust: boolean): Promise<boolean> {
    let candidate = false;
    try {
      candidate = await trust.hasProjectCandidate(ctx.cwd, CONFIG_DIR_NAME);
    } catch {
      return false;
    }
    if (!candidate) return false;
    if (ctx.isProjectTrusted() && trust.hasStandardResources(ctx.cwd)) return true;

    let saved: boolean | null;
    try {
      saved = trust.getSavedDecision(ctx.cwd);
    } catch {
      return false;
    }
    if (saved === true && ctx.isProjectTrusted()) return true;
    if (saved !== null || !requestTrust || ctx.mode !== "tui" || !ctx.hasUI || !ctx.isProjectTrusted()) return false;

    const confirmed = await confirmProjectTrust(ctx.cwd, (title, message) => ctx.ui.confirm(title, message));
    try {
      trust.rememberDecision(ctx.cwd, confirmed);
    } catch {
      ctx.ui.notify("Could not save project trust; project micro-manager config remains inactive", "error");
      return false;
    }
    if (!confirmed) return false;
    ctx.ui.notify("Project trust saved. Other project resources can load after Pi restarts.", "warning");
    return true;
  }

  function isEnabled(): boolean {
    return sessionOverride ?? configuration?.settings.enabled ?? false;
  }

  function usesPrimaryModel(): boolean {
    if (!configuration) return true;
    const definitions = configuredDefinitions(configuration);
    return definitions.some((definition) => !definition.model);
  }

  function rebuildRunners(ctx: ExtensionContext, seedToCurrent: boolean): void {
    const expectedEpoch = ++sessionEpoch;
    stopRunners(false);
    activeContext = ctx;
    inactiveStats = [];
    pendingHeadlessNotes = [];
    if (!isEnabled() || !configuration) {
      if (seedToCurrent) cursor.seed(ctx.sessionManager.getBranch());
      refreshStatus(ctx);
      return;
    }

    for (const definition of configuredDefinitions(configuration)) {
      if (!definition.enabled) {
        inactiveStats.push(emptyStats(definition.name, "paused"));
        continue;
      }
      const resolved = resolveMicroManagerModel(definition, ctx);
      if (!resolved) {
        inactiveStats.push(emptyStats(definition.name, "no_model"));
        continue;
      }
      const runner = createRunner({
        name: definition.name,
        model: resolved.model,
        thinking: resolved.thinking,
        systemPrompt: buildMicroManagerSystemPrompt(definition, {
          priorityBlocks: configuration.priorityBlocks,
          ...(configuration.sharedInstructions ? { sharedInstructions: configuration.sharedInstructions } : {}),
        }),
        tools: createWorkspaceTools(definition.tools, ctx.cwd),
        complete: (model, context, options) => ctx.modelRegistry.complete(model, context, options),
        timeoutMs: configuration.settings.timeoutMs,
        maxOutputTokens: configuration.settings.maxOutputTokens,
        maxToolRounds: configuration.settings.maxToolRounds,
        maxContextChars: configuration.settings.maxContextChars,
        maxAttempts: configuration.settings.maxAttempts,
        onReport: (note) => {
          if (expectedEpoch !== sessionEpoch || activeContext !== ctx) return;
          routeReport({ ...note, model: `${resolved.model.provider}/${resolved.model.id}` }, ctx);
        },
        onStateChange: () => {
          if (expectedEpoch === sessionEpoch && activeContext === ctx) refreshStatus(ctx);
        },
      });
      runners.push(runner);
    }
    if (seedToCurrent) cursor.seed(ctx.sessionManager.getBranch());
    refreshStatus(ctx);
  }

  function stopRunners(incrementEpoch = true): void {
    if (incrementEpoch) sessionEpoch++;
    const current = runners;
    runners = [];
    for (const runner of current) runner.dispose();
  }

  function routeReport(note: MicroManagerNote, ctx: ExtensionContext): void {
    deliveredNotes++;
    if (ctx.mode === "print" || ctx.mode === "json") {
      pendingHeadlessNotes.push(note);
      refreshStatus(ctx);
      return;
    }
    const interrupting = isInterruptingSeverity(note.severity);
    const immune =
      interrupting &&
      immuneTurnStart !== undefined &&
      completedTurns < immuneTurnStart + (configuration?.settings.immuneTurns ?? 3);
    const message = createReportMessage([note]);

    if (!interrupting || immune) {
      if (ctx.isIdle()) pi.sendMessage(message);
      else pi.sendMessage(message, { deliverAs: "followUp" });
      return;
    }
    if (ctx.isIdle() && note.severity !== "blocker") {
      pi.sendMessage(message);
      return;
    }
    immuneTurnStart = completedTurns + 1;
    pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
  }

  function flushHeadlessNotes(ctx: ExtensionContext): void {
    if (pendingHeadlessNotes.length === 0) return;
    const notes = pendingHeadlessNotes;
    pendingHeadlessNotes = [];
    const message = createReportMessage(notes);
    if (ctx.mode === "print") {
      pi.appendEntry("micro-manager-report", { content: message.content, details: message.details });
      return;
    }
    pi.sendMessage(message);
  }

  function createReportMessage(notes: readonly MicroManagerNote[]) {
    return {
      customType: "micro-manager",
      content: formatMicroManagerBatchContent(notes),
      display: true,
      details: microManagerMessageDetails(notes),
    };
  }

  function allStats(): MicroManagerRuntimeStats[] {
    return [...runners.map((runner) => runner.stats), ...inactiveStats];
  }

  function statusText(): string {
    const stats = allStats();
    const lines = [`micro-manager: ${isEnabled() ? (runners.length > 0 ? "active" : "enabled, unavailable") : "disabled"}`];
    if (configuration) {
      lines.push(`config: ${configuration.sources.length > 0 ? configuration.sources.join(", ") : "none"}`);
      if (configuration.projectConfigDetected && !configuration.projectConfigLoaded) {
        lines.push("project config: ignored until project trust is granted");
      }
      if (configuration.errors.length > 0) lines.push(`warnings: ${configuration.errors.length}`);
    }
    for (const stat of stats) {
      const model = stat.model ? ` ${stat.model.provider}/${stat.model.id}` : "";
      const usage = stat.turns > 0 ? ` · ${stat.inputTokens} in/${stat.outputTokens} out · $${stat.cost.toFixed(4)}` : "";
      const backlog = stat.backlog > 0 ? ` · backlog ${stat.backlog}` : "";
      lines.push(`- ${stat.name}: ${stat.state}${model}${usage}${backlog}`);
      if (stat.lastError) lines.push(`  ${stat.lastError}`);
    }
    if (deliveredNotes > 0) lines.push(`notes delivered: ${deliveredNotes}`);
    return lines.join("\n");
  }

  // ponytail: blink is a footer-status timer, not setWorkingIndicator — that would hijack the primary spinner
  const BLINK_FRAMES = ["¬_¬", "¬_¬", "¬_¬", "-_-"];

  function stopBlink(): void {
    if (!blinkTimer) return;
    clearInterval(blinkTimer);
    blinkTimer = undefined;
    blinkFrame = 0;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!configuration && runners.length === 0) {
      stopBlink();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const stats = allStats();
    const hasError = stats.some((stat) => stat.state === "error");
    const backlog = stats.reduce((sum, stat) => sum + stat.backlog, 0);
    const theme = ctx.ui.theme;
    if (isEnabled() && !hasError && backlog > 0) {
      if (!blinkTimer) {
        blinkTimer = setInterval(() => {
          blinkFrame++;
          if (activeContext) refreshStatus(activeContext);
        }, 600);
        blinkTimer.unref?.();
      }
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `${BLINK_FRAMES[blinkFrame % BLINK_FRAMES.length]} …`));
      return;
    }
    stopBlink();
    if (!isEnabled()) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "^_^"));
    } else if (hasError) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("error", "¬_¬ !"));
    } else if (runners.length > 0) {
      const count = runners.length > 1 ? ` ×${runners.length}` : "";
      ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", `¬_¬${count}`));
    } else {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "¬_¬ ?"));
    }
  }
}

function configuredDefinitions(configuration: MicroManagerConfiguration): MicroManagerDefinition[] {
  if (configuration.managers.length > 0) return configuration.managers;
  const definition: MicroManagerDefinition = {
    name: "default",
    enabled: true,
    thinking: configuration.settings.thinking,
    tools: [...configuration.settings.tools],
  };
  if (configuration.settings.model) definition.model = configuration.settings.model;
  return [definition];
}

function resolveMicroManagerModel(
  definition: MicroManagerDefinition,
  ctx: ExtensionContext,
): { model: Model<any>; thinking: ThinkingLevel } | undefined {
  if (!definition.model) return ctx.model ? { model: ctx.model, thinking: definition.thinking } : undefined;
  const parsed = splitThinkingSuffix(definition.model);
  let model: Model<any> | undefined;
  const slash = parsed.selector.indexOf("/");
  if (slash > 0) {
    model = ctx.modelRegistry.find(parsed.selector.slice(0, slash), parsed.selector.slice(slash + 1));
  } else {
    const matches = ctx.modelRegistry.getAll().filter((candidate) => candidate.id === parsed.selector);
    if (matches.length === 1) model = matches[0];
  }
  return model ? { model, thinking: parsed.thinking ?? definition.thinking } : undefined;
}

function splitThinkingSuffix(value: string): { selector: string; thinking?: ThinkingLevel } {
  const colon = value.lastIndexOf(":");
  if (colon <= value.indexOf("/")) return { selector: value };
  const suffix = value.slice(colon + 1) as ThinkingLevel;
  if (!THINKING_LEVELS.has(suffix)) return { selector: value };
  return { selector: value.slice(0, colon), thinking: suffix };
}

function emptyStats(name: string, state: "paused" | "no_model"): MicroManagerRuntimeStats {
  return { name, state, backlog: 0, turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

async function confirmProjectTrust(
  cwd: string,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<boolean> {
  return confirm(
    "Trust project and enable The Micro Manager?",
    `Project: ${cwd}\n\nProject MICRO_MANAGER files can select review models, add instructions, and grant read-only access to workspace files. The Micro Manager sends bounded transcript and tool excerpts to the selected model. Trust this project?`,
  );
}

function configGuidance(ctx: ExtensionContext): string {
  return `Create ${ctx.cwd}/${CONFIG_DIR_NAME}/MICRO_MANAGER.yml, then run /micro-manager reload:\n\nenabled: true\nthinking: low\ntools: [read, grep, find, ls]\nmanagers:\n  - name: Architecture\n    # model: anthropic/claude-sonnet-4-6:medium\n    instructions: |\n      Watch module seams and public-interface growth.\n\nOptional review priorities belong in ${ctx.cwd}/${CONFIG_DIR_NAME}/MICRO_MANAGER.md. Project files require project trust. User-level defaults can live in ${getAgentDir()}/MICRO_MANAGER.yml and MICRO_MANAGER.md.`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
