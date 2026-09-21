import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MicroManagerToolName } from "./types.ts";

export function createWorkspaceTools(names: readonly MicroManagerToolName[], cwd: string): AgentTool[] {
  return names.map((name) => confineTool(createTool(name, cwd), cwd));
}

function createTool(name: MicroManagerToolName, cwd: string): AgentTool {
  if (name === "read") return createReadTool(cwd);
  if (name === "grep") return createGrepTool(cwd);
  if (name === "find") return createFindTool(cwd);
  return createLsTool(cwd);
}

function confineTool(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      await assertWorkspacePath(cwd, params);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

async function assertWorkspacePath(cwd: string, params: unknown): Promise<void> {
  if (!isRecord(params) || params.path === undefined) return;
  if (typeof params.path !== "string") throw new Error("Tool path must be a string");

  const root = path.resolve(cwd);
  const target = path.resolve(root, params.path);
  if (!isWithin(root, target)) throw new Error("Tool path must stay inside the trusted workspace");

  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (!isWithin(realRoot, realTarget)) {
    throw new Error("Tool path must not follow a link outside the trusted workspace");
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
