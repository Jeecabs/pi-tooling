import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkspaceTools } from "../src/workspace-tools.ts";

test("read-only tools reject paths and links outside the trusted workspace", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "micro-manager-workspace-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, "workspace");
  const outside = path.join(temp, "outside.txt");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "inside.txt"), "inside\n");
  await fs.writeFile(outside, "outside\n");
  await fs.symlink(outside, path.join(workspace, "linked.txt"));

  const read = createWorkspaceTools(["read"], workspace)[0];
  assert.ok(read);
  const signal = new AbortController().signal;
  const inside = await read.execute("inside", { path: "inside.txt" }, signal);
  assert.match(inside.content[0]?.type === "text" ? inside.content[0].text : "", /inside/);

  await assert.rejects(read.execute("absolute", { path: outside }, signal), /inside the trusted workspace/);
  await assert.rejects(read.execute("parent", { path: "../outside.txt" }, signal), /inside the trusted workspace/);
  await assert.rejects(read.execute("link", { path: "linked.txt" }, signal), /link outside the trusted workspace/);
});
