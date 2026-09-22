import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileThreadWorkspaces } from "../lib/cleanup.ts";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const record = { threadId: "t1", projectId: "pa", parentThreadId: null, title: "One" };

test("cleanup rule: a thread must be missing from two consecutive index refreshes before it is a candidate", () => {
  const first = reconcileThreadWorkspaces([record], [], new Map());
  assert.deepEqual(first.candidates, []);
  assert.equal(first.misses.get("t1"), 1);
  // Transient miss: it is back → counter resets.
  const back = reconcileThreadWorkspaces([record], [{ id: "t1", projectId: "pa", parentThreadId: null, title: "One" }], first.misses);
  assert.deepEqual(back.candidates, []); assert.equal(back.misses.has("t1"), false);
  const second = reconcileThreadWorkspaces([record], [], first.misses);
  assert.deepEqual(second.candidates, ["t1"], "second consecutive miss → ask the server");
  assert.equal(second.misses.get("t1"), 2);
});

test("index carries parentThreadId; threadsGone confirms deleted/archived and reports unknown for other errors", async () => {
  const live = makeThreadResponse({ id: "t_live", projectId: "pa", parentThreadId: "t_root", title: "Live", archivedAt: null });
  const archived = makeThreadResponse({ id: "t_arch", projectId: "pa", archivedAt: 123 });
  const host = createFakePluginHost({ pluginId: "pane-workspaces", sdk: {
    subscribe: () => () => {},
    projects: { list: async () => [] },
    threads: {
      list: async () => [live],
      get: async ({ threadId }) => {
        if (threadId === "t_live") return live;
        if (threadId === "t_arch") return archived;
        if (threadId === "t_gone") throw Object.assign(new Error("Thread not found"), { status: 404 });
        throw new Error("temporarily unavailable");
      },
    },
  } });
  await plugin(host.bb);
  try {
    const index = await host.harness.behavior.callRpc("index", null) as { threads: Array<{ id: string; parentThreadId: string | null }> };
    assert.deepEqual(index.threads.map((t) => [t.id, t.parentThreadId]), [["t_live", "t_root"]]);
    const result = await host.harness.behavior.callRpc("threadsGone", { threadIds: ["t_live", "t_arch", "t_gone", "t_flaky", "t_gone"] });
    assert.deepEqual(result, { gone: ["t_arch", "t_gone"], unknown: ["t_flaky"] });
    await assert.rejects(host.harness.behavior.callRpc("threadsGone", { threadIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }), "bounded input");
  } finally { await host.harness.lifecycle.dispose(); }
});
