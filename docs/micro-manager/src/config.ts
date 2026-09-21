import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { normalizeMicroManagerText } from "./message-format.ts";
import {
  MICRO_MANAGER_TOOL_NAMES,
  type MicroManagerConfiguration,
  type MicroManagerDefinition,
  type MicroManagerSettings,
  type MicroManagerToolName,
} from "./types.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_MANAGERS = 8;
const MAX_MANAGER_NAME_CHARS = 80;
const DEFAULT_SETTINGS: MicroManagerSettings = {
  enabled: false,
  thinking: "low",
  tools: [...MICRO_MANAGER_TOOL_NAMES],
  timeoutMs: 30_000,
  maxInputChars: 24_000,
  maxOutputTokens: 512,
  maxToolRounds: 3,
  maxContextChars: 100_000,
  maxAttempts: 2,
  immuneTurns: 3,
};

const TOP_LEVEL_KEYS = new Set([
  "enabled",
  "model",
  "thinking",
  "tools",
  "timeout_ms",
  "max_input_chars",
  "max_output_tokens",
  "max_tool_rounds",
  "max_context_chars",
  "max_attempts",
  "immune_turns",
  "instructions",
  "managers",
]);
const MICRO_MANAGER_KEYS = new Set(["name", "enabled", "model", "thinking", "tools", "instructions"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TOOL_ALIASES = new Map<string, MicroManagerToolName>([
  ["read", "read"],
  ["grep", "grep"],
  ["search", "grep"],
  ["find", "find"],
  ["glob", "find"],
  ["ls", "ls"],
]);

interface ConfigCandidate {
  path: string;
  level: "user" | "project";
  kind: "yaml" | "markdown";
}

interface PartialSettings {
  enabled?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: MicroManagerToolName[];
  timeoutMs?: number;
  maxInputChars?: number;
  maxOutputTokens?: number;
  maxToolRounds?: number;
  maxContextChars?: number;
  maxAttempts?: number;
  immuneTurns?: number;
}

interface ParsedMicroManager {
  name: string;
  enabled?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: MicroManagerToolName[];
  instructions?: string;
}

interface ParsedYaml {
  settings: PartialSettings;
  instructions?: string;
  managers: ParsedMicroManager[];
}

export interface MicroManagerConfigDiscoveryOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  configDirName?: string;
}

export async function hasProjectMicroManagerCandidate(
  cwd: string,
  configDirName = CONFIG_DIR_NAME,
): Promise<boolean> {
  const dirs = await projectDirectories(cwd);
  for (const dir of dirs) {
    for (const location of [dir, path.join(dir, configDirName)]) {
      for (const filename of ["MICRO_MANAGER.yml", "MICRO_MANAGER.yaml", "MICRO_MANAGER.md"]) {
        if (await pathExists(path.join(location, filename))) return true;
      }
    }
  }
  return false;
}

export async function discoverMicroManagerConfiguration(
  options: MicroManagerConfigDiscoveryOptions,
): Promise<MicroManagerConfiguration> {
  const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
  const projectConfigDetected = await hasProjectMicroManagerCandidate(options.cwd, configDirName);
  const candidates = await collectCandidates(options.cwd, options.agentDir, options.includeProject, configDirName);
  const settingsPatch: PartialSettings = {};
  const managerMap = new Map<string, ParsedMicroManager>();
  const sharedInstructions: string[] = [];
  const priorityBlocks: string[] = [];
  const sources: string[] = [];
  const errors: string[] = [];
  let projectConfigLoaded = false;

  for (const candidate of candidates) {
    try {
      const content = await readBoundedRegularFile(candidate.path);
      sources.push(candidate.path);
      if (candidate.level === "project") projectConfigLoaded = true;
      if (candidate.kind === "markdown") {
        appendPriorityBlock(content, priorityBlocks);
        continue;
      }

      const parsed = parseConfigYaml(content, candidate.path);
      Object.assign(settingsPatch, parsed.settings);
      if (parsed.instructions) sharedInstructions.push(parsed.instructions);
      for (const manager of parsed.managers) {
        const slug = slugifyMicroManagerName(manager.name);
        managerMap.delete(slug);
        managerMap.set(slug, manager);
      }
    } catch (error) {
      errors.push(`${candidate.path}: ${errorMessage(error)}`);
    }
  }

  const settings = mergeSettings(settingsPatch);
  const managers = materializeManagers(managerMap, settings, errors);
  const result: MicroManagerConfiguration = {
    settings,
    managers,
    priorityBlocks,
    sources,
    errors,
    projectConfigDetected,
    projectConfigLoaded,
  };
  const instructions = sharedInstructions.join("\n\n").trim();
  if (instructions) result.sharedInstructions = instructions;
  return result;
}

export function parseConfigYaml(content: string, source = "MICRO_MANAGER.yml"): ParsedYaml {
  const document = parseDocument(content, { prettyErrors: true, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "));
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (value === null || value === undefined) return { settings: {}, managers: [] };
  if (!isRecord(value)) throw new Error("expected a YAML mapping");
  assertKnownKeys(value, TOP_LEVEL_KEYS, source);

  const settings: PartialSettings = {};
  if ("enabled" in value) settings.enabled = booleanValue(value.enabled, "enabled");
  if ("model" in value) settings.model = nonEmptyString(value.model, "model");
  if ("thinking" in value) settings.thinking = thinkingValue(value.thinking, "thinking");
  if ("tools" in value) settings.tools = toolsValue(value.tools, "tools");
  if ("timeout_ms" in value) settings.timeoutMs = integerValue(value.timeout_ms, "timeout_ms", 1_000, 120_000);
  if ("max_input_chars" in value) {
    settings.maxInputChars = integerValue(value.max_input_chars, "max_input_chars", 2_000, 100_000);
  }
  if ("max_output_tokens" in value) {
    settings.maxOutputTokens = integerValue(value.max_output_tokens, "max_output_tokens", 64, 4_096);
  }
  if ("max_tool_rounds" in value) {
    settings.maxToolRounds = integerValue(value.max_tool_rounds, "max_tool_rounds", 0, 8);
  }
  if ("max_context_chars" in value) {
    settings.maxContextChars = integerValue(value.max_context_chars, "max_context_chars", 8_000, 500_000);
  }
  if ("max_attempts" in value) settings.maxAttempts = integerValue(value.max_attempts, "max_attempts", 1, 3);
  if ("immune_turns" in value) settings.immuneTurns = integerValue(value.immune_turns, "immune_turns", 0, 20);

  const result: ParsedYaml = { settings, managers: [] };
  if ("instructions" in value) result.instructions = nonEmptyString(value.instructions, "instructions");
  if ("managers" in value) {
    if (!Array.isArray(value.managers)) throw new Error("managers must be an array");
    if (value.managers.length > MAX_MANAGERS) throw new Error(`managers must contain at most ${MAX_MANAGERS} entries`);
    result.managers = value.managers.map((entry, index) => parseMicroManager(entry, index));
  }
  return result;
}

export function slugifyMicroManagerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "micro-manager";
}

function parseMicroManager(value: unknown, index: number): ParsedMicroManager {
  const field = `managers[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be a mapping`);
  assertKnownKeys(value, MICRO_MANAGER_KEYS, field);
  const manager: ParsedMicroManager = { name: managerName(value.name, `${field}.name`) };
  if ("enabled" in value) manager.enabled = booleanValue(value.enabled, `${field}.enabled`);
  if ("model" in value) manager.model = nonEmptyString(value.model, `${field}.model`);
  if ("thinking" in value) manager.thinking = thinkingValue(value.thinking, `${field}.thinking`);
  if ("tools" in value) manager.tools = toolsValue(value.tools, `${field}.tools`);
  if ("instructions" in value) {
    manager.instructions = nonEmptyString(value.instructions, `${field}.instructions`);
  }
  return manager;
}

function appendPriorityBlock(content: string, blocks: string[]): void {
  const body = content.trim();
  if (body) blocks.push(`Especially pay attention to:\n<attention>\n${body}\n</attention>`);
}

function materializeManagers(
  managerMap: ReadonlyMap<string, ParsedMicroManager>,
  settings: MicroManagerSettings,
  errors: string[],
): MicroManagerDefinition[] {
  const configured = [...managerMap.values()];
  if (configured.length > MAX_MANAGERS) {
    errors.push(
      `configuration defines ${configured.length} managers; only the ${MAX_MANAGERS} most specific are active`,
    );
  }
  return configured.slice(-MAX_MANAGERS).map((manager) => materializeMicroManager(manager, settings));
}

function materializeMicroManager(manager: ParsedMicroManager, settings: MicroManagerSettings): MicroManagerDefinition {
  const result: MicroManagerDefinition = {
    name: manager.name,
    enabled: manager.enabled ?? true,
    thinking: manager.thinking ?? settings.thinking,
    tools: [...(manager.tools ?? settings.tools)],
  };
  const model = manager.model ?? settings.model;
  if (model) result.model = model;
  if (manager.instructions) result.instructions = manager.instructions;
  return result;
}

function mergeSettings(patch: PartialSettings): MicroManagerSettings {
  const settings: MicroManagerSettings = {
    ...DEFAULT_SETTINGS,
    ...patch,
    tools: [...(patch.tools ?? DEFAULT_SETTINGS.tools)],
  };
  if (!patch.model) delete settings.model;
  return settings;
}

async function collectCandidates(
  cwd: string,
  agentDir: string,
  includeProject: boolean,
  configDirName: string,
): Promise<ConfigCandidate[]> {
  const candidates: ConfigCandidate[] = [];
  await appendLocationCandidates(candidates, agentDir, "user");
  if (!includeProject) return candidates;

  const dirs = await projectDirectories(cwd);
  for (const dir of dirs) {
    await appendLocationCandidates(candidates, dir, "project");
    await appendLocationCandidates(candidates, path.join(dir, configDirName), "project");
  }
  return candidates;
}

async function appendLocationCandidates(
  candidates: ConfigCandidate[],
  location: string,
  level: ConfigCandidate["level"],
): Promise<void> {
  const yml = path.join(location, "MICRO_MANAGER.yml");
  const yaml = path.join(location, "MICRO_MANAGER.yaml");
  if (await pathExists(yml)) candidates.push({ path: yml, level, kind: "yaml" });
  else if (await pathExists(yaml)) candidates.push({ path: yaml, level, kind: "yaml" });

  const markdown = path.join(location, "MICRO_MANAGER.md");
  if (await pathExists(markdown)) candidates.push({ path: markdown, level, kind: "markdown" });
}

async function projectDirectories(cwd: string): Promise<string[]> {
  const resolved = path.resolve(cwd);
  const walked: string[] = [];
  let current = resolved;
  while (true) {
    walked.push(current);
    if (await pathExists(path.join(current, ".git"))) return walked.reverse();
    const parent = path.dirname(current);
    if (parent === current) return [resolved];
    current = parent;
  }
}

async function readBoundedRegularFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("must be a regular file, not a symlink");
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`exceeds ${MAX_CONFIG_BYTES} bytes`);
  return fs.readFile(filePath, "utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);
}

function toolsValue(value: unknown, field: string): MicroManagerToolName[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const tools: MicroManagerToolName[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string`);
    const normalized = TOOL_ALIASES.get(item.trim().toLowerCase());
    if (!normalized) throw new Error(`${field}[${index}] is not a read-only micro-manager tool: ${item}`);
    if (!tools.includes(normalized)) tools.push(normalized);
  }
  return tools;
}

function thinkingValue(value: unknown, field: string): ThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new Error(`${field} must be one of: ${[...THINKING_LEVELS].join(", ")}`);
  }
  return value as ThinkingLevel;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function managerName(value: unknown, field: string): string {
  const name = nonEmptyString(value, field);
  if (name.length > MAX_MANAGER_NAME_CHARS) {
    throw new Error(`${field} must contain at most ${MAX_MANAGER_NAME_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name) || normalizeMicroManagerText(name) !== name) {
    throw new Error(`${field} contains unsupported control or formatting characters`);
  }
  return name;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
