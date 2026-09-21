import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptExcerpt, TranscriptCursor } from "../src/transcript.ts";

const entries = [
  {
    type: "message",
    id: "u1",
    message: { role: "user", content: [{ type: "text", text: "Fix the queue." }] },
  },
  {
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Hidden chain of thought" },
        { type: "text", text: "I will inspect it." },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "src/queue.ts", token: "sk-supersecretvalue123" },
        },
      ],
    },
  },
  {
    type: "message",
    id: "t1",
    message: {
      role: "toolResult",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "Authorization: Bearer secret-token-value" }],
    },
  },
  {
    type: "message",
    id: "manager-1",
    message: { role: "custom", customType: "micro-manager", content: "Do not recurse." },
  },
];

test("renders useful transcript evidence while omitting thinking and prior report", () => {
  const excerpt = buildTranscriptExcerpt(entries, 20_000) ?? "";
  assert.match(excerpt, /Fix the queue/);
  assert.match(excerpt, /src\/queue\.ts/);
  assert.match(excerpt, /\[REDACTED\]/);
  assert.match(excerpt, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(excerpt, /Hidden chain of thought/);
  assert.doesNotMatch(excerpt, /Do not recurse/);
});

test("cursor emits only new entries on append-only history", () => {
  const cursor = new TranscriptCursor();
  const first = cursor.next(entries, 20_000);
  assert.match(first?.text ?? "", /Fix the queue/);
  const nextEntries = [
    ...entries,
    {
      type: "message",
      id: "a2",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Queue fixed." }] },
    },
  ];
  const second = cursor.next(nextEntries, 20_000);
  assert.equal(second?.reset, false);
  assert.match(second?.text ?? "", /Queue fixed/);
  assert.doesNotMatch(second?.text ?? "", /Fix the queue/);
  assert.equal(cursor.next(nextEntries, 20_000), undefined);
});

test("cursor replays bounded current history after a branch rewrite", () => {
  const cursor = new TranscriptCursor();
  cursor.seed(entries);
  const rewritten = [
    {
      type: "message",
      id: "new-user",
      message: { role: "user", content: "Take another approach." },
    },
  ];
  const delta = cursor.next(rewritten, 20_000);
  assert.equal(delta?.reset, true);
  assert.match(delta?.text ?? "", /another approach/);
});

test("total excerpt respects its hard character budget", () => {
  const huge = [
    {
      type: "message",
      id: "huge",
      message: { role: "toolResult", toolName: "read", content: "x".repeat(100_000), isError: false },
    },
  ];
  const excerpt = buildTranscriptExcerpt(huge, 2_000) ?? "";
  assert.ok(excerpt.length <= 2_000, `expected <= 2000 chars, got ${excerpt.length}`);
  assert.match(excerpt, /…/);
});
