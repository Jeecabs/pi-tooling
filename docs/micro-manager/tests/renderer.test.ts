import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderMicroManagerMessage } from "../src/renderer.ts";

test("removes terminal controls from persisted names and notes", () => {
  const theme = {
    bg: (_color: string, text: string) => text,
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const component = renderMicroManagerMessage(
    {
      role: "custom",
      customType: "micro-manager",
      content: "",
      display: true,
      timestamp: Date.now(),
      details: {
        notes: [
          {
            note: "safe\u001b]0;unsafe\u0007 note",
            manager: "\u001b]0;unsafe\u0007Architecture",
            severity: "nit",
          },
        ],
      },
    },
    { expanded: false, outputPad: 0 },
    theme,
  );

  assert.ok(component);
  const rendered = JSON.stringify(component.render(120));
  assert.doesNotMatch(rendered, /[\u001b\u0007\u202e]/);
  assert.match(rendered, /Architecture/);
  assert.match(rendered, /safe note/);
});
