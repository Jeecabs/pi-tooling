import type { MicroManagerMessageDetails, MicroManagerNote, MicroManagerSeverity } from "./types.ts";

const MICRO_MANAGER_GUIDANCE = "weigh, don't blindly obey";

export function normalizeMicroManagerText(value: string): string | undefined {
  const normalized = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized || undefined;
}

export function isMicroManagerSeverity(value: unknown): value is MicroManagerSeverity {
  return value === "nit" || value === "concern" || value === "blocker";
}

export function isInterruptingSeverity(severity: MicroManagerSeverity | undefined): boolean {
  return severity === "concern" || severity === "blocker";
}

export function formatMicroManagerBatchContent(notes: readonly MicroManagerNote[]): string {
  return notes
    .map((entry) => {
      const manager = entry.manager ? ` manager="${escapeXml(entry.manager)}"` : "";
      const severity = entry.severity ? ` severity="${entry.severity}"` : "";
      return `<micro-manager-note${manager}${severity} guidance="${MICRO_MANAGER_GUIDANCE}">\n${escapeXml(entry.note)}\n</micro-manager-note>`;
    })
    .join("\n");
}

export function microManagerMessageDetails(notes: readonly MicroManagerNote[]): MicroManagerMessageDetails {
  return { notes: [...notes] };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
