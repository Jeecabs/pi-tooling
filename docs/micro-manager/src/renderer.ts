import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { normalizeMicroManagerText } from "./message-format.ts";
import { MICRO_MANAGER_SEVERITIES, type MicroManagerMessageDetails, type MicroManagerSeverity } from "./types.ts";

// ponytail: ASCII/Latin-1 face — Kannada ಠ falls back to non-mono fonts and breaks alignment
const MICRO_MANAGER_GLYPH = "¬_¬";

const SEVERITY_GLYPHS: Record<MicroManagerSeverity, string> = { nit: "·", concern: "▲", blocker: "✖" };

export const renderMicroManagerMessage: MessageRenderer<MicroManagerMessageDetails> = (
  message,
  { expanded, outputPad },
  theme,
) => {
  const notes = message.details?.notes ?? [];
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const counts: Record<MicroManagerSeverity, number> = { nit: 0, concern: 0, blocker: 0 };
  for (const note of notes) counts[note.severity ?? "nit"]++;
  const summary = [...MICRO_MANAGER_SEVERITIES]
    .reverse()
    .filter((severity) => counts[severity] > 0)
    .map((severity) => theme.fg(severityColor(severity), `${SEVERITY_GLYPHS[severity]}${counts[severity]}`))
    .join(" ");
  const label = `${theme.fg("accent", theme.bold(MICRO_MANAGER_GLYPH))} ${theme.fg("customMessageLabel", theme.bold("[micro-manager]"))}`;
  box.addChild(new Text(`${label}  ${summary}`.trimEnd(), 0, 0));

  const shown = expanded ? notes : notes.slice(0, 3);
  for (const entry of shown) {
    const severity = entry.severity ?? "nit";
    const glyph = theme.fg(severityColor(severity), SEVERITY_GLYPHS[severity]);
    const source = entry.manager ? `${theme.fg("dim", sanitize(entry.manager))} ` : "";
    const detail = expanded && entry.model ? theme.fg("dim", ` · ${sanitize(entry.model)}`) : "";
    box.addChild(new Text(`${glyph} ${source}${sanitize(entry.note)}${detail}`, 0, 0));
  }
  if (shown.length < notes.length) {
    box.addChild(new Text(theme.fg("dim", `+${notes.length - shown.length}`), 0, 0));
  }
  if (notes.length === 0) box.addChild(new Text(sanitize(contentText(message.content)), 0, 0));
  return box;
};

function severityColor(severity: MicroManagerSeverity): "muted" | "warning" | "error" {
  if (severity === "blocker") return "error";
  if (severity === "concern") return "warning";
  return "muted";
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

function sanitize(value: string): string {
  return (normalizeMicroManagerText(value) ?? "").replaceAll("\t", "  ");
}
