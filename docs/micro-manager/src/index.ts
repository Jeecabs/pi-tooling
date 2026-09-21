import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMicroManagerExtension } from "./extension.ts";

export { MicroManagerRunner } from "./micro-manager-runner.ts";
export * from "./message-format.ts";
export * from "./config.ts";
export * from "./emission-guard.ts";
export { registerMicroManagerExtension } from "./extension.ts";
export * from "./transcript.ts";
export * from "./types.ts";

export default function microManagerExtension(pi: ExtensionAPI): void {
  registerMicroManagerExtension(pi);
}
