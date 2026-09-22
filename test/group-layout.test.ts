import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, single } from "./dom.ts";

const dom = installDom();
const L = await import("../lib/layout.ts");
const G = await import("../lib/group-layout.ts");
const S = await import("../lib/switching.ts");

beforeEach(() => dom.reset());

type T = { id: string; projectId: string; parentThreadId: string | null; createdAt: number; status?: string; latestAttentionAt?: number };
const t = (id: string, parentThreadId: string | null, createdAt: number, extra: Partial<T> = {}): T => ({ id, projectId: "pa", parentThreadId, createdAt, status: "idle", latestAttentionAt: createdAt, ...extra });
/** anchor with n direct children c1..cn (createdAt ascending by index), grandchildren under c1, unrelated threads. */
function tree(n: number) {
  const out = [t("anchor", null, 1), t("other", null, 0), t("cousin", "other", 7), t("g1", "c1", 100), t("g2", "c1", 101)];
  for (let i = 1; i <= n; i++) out.push(t(`c${i}`, "anchor", 10 + i));
  return out;
}
const panes = (root: any): any[] => root.type === "pane" ? [root] : root.children.flatMap(panes);
const ids = (d: any) => panes(d.layout.root).map((p) => p.content.threadId);

test("group: anchor + direct children only; grandchildren and unrelated threads excluded; newest child first", () => {
  assert.deepEqual(G.groupOf("anchor", tree(3)).map((x) => x.id), ["anchor", "c3", "c2", "c1"]);
  assert.deepEqual(G.groupOf("missing", tree(3)), []);
  assert.deepEqual(G.childrenOf("c1", tree(3)).map((x) => x.id), ["g2", "g1"], "a child's own group holds the grandchildren");
});

test("ordering matches bb's sidebar rule: active first by createdAt desc, then latestAttentionAt desc, createdAt desc, id", () => {
  const threads = [
    t("anchor", null, 1),
    t("old-active", "anchor", 2, { status: "active", latestAttentionAt: 2 }),
    t("new-active", "anchor", 9, { status: "active", latestAttentionAt: 3 }),
    t("stale-new", "anchor", 8, { latestAttentionAt: 10 }),
    t("fresh-old", "anchor", 3, { latestAttentionAt: 50 }),
    t("tie-b", "anchor", 5, { latestAttentionAt: 20 }),
    t("tie-a", "anchor", 5, { latestAttentionAt: 20 }),
  ];
  assert.deepEqual(G.childrenOf("anchor", threads).map((x) => x.id), ["new-active", "old-active", "fresh-old", "tie-a", "tie-b", "stale-new"]);
  // Without latestAttentionAt the fallback is createdAt desc.
  const bare = [t("anchor", null, 1), { id: "x", projectId: "pa", parentThreadId: "anchor", createdAt: 2 }, { id: "y", projectId: "pa", parentThreadId: "anchor", createdAt: 3 }];
  assert.deepEqual(G.childrenOf("anchor", bare).map((x) => x.id), ["y", "x"]);
});

test("shapes: 0 → single; 1 → row 50/50; 2 → left 45% + vertical stack; 5 → stack of five; 8 → first six + omission; anchor focused", () => {
  const zero = G.deriveGroupLayout("anchor", tree(0))!;
  assert.equal(zero.layout.root.type, "pane"); assert.deepEqual(zero.placed, ["anchor"]); assert.deepEqual(zero.omitted, []);
  const one = G.deriveGroupLayout("anchor", tree(1))!;
  assert.equal((one.layout.root as any).dir, "row"); assert.deepEqual((one.layout.root as any).sizes, [0.5, 0.5]);
  assert.deepEqual(ids(one), ["anchor", "c1"]);
  const two = G.deriveGroupLayout("anchor", tree(2))!;
  const root2 = two.layout.root as any;
  assert.equal(root2.dir, "row"); assert.deepEqual(root2.sizes, [0.45, 0.55]);
  assert.equal(root2.children[0].type, "pane"); assert.equal(root2.children[0].content.threadId, "anchor", "anchor is the full-height left column");
  assert.equal(root2.children[1].type, "split"); assert.equal(root2.children[1].dir, "col"); assert.deepEqual(root2.children[1].sizes, [0.5, 0.5]);
  assert.deepEqual(ids(two), ["anchor", "c2", "c1"], "children stacked newest first");
  const five = G.deriveGroupLayout("anchor", tree(5))!;
  const stack5 = (five.layout.root as any).children[1];
  assert.equal(stack5.dir, "col"); assert.equal(stack5.children.length, 5);
  assert.ok(stack5.sizes.every((s: number) => Math.abs(s - 0.2) < 1e-9), "equal heights");
  assert.deepEqual(ids(five), ["anchor", "c5", "c4", "c3", "c2", "c1"]); assert.deepEqual(five.omitted, []);
  const eight = G.deriveGroupLayout("anchor", tree(8))!;
  assert.deepEqual(ids(eight), ["anchor", "c8", "c7", "c6", "c5", "c4", "c3"]); assert.deepEqual(eight.omitted, ["c2", "c1"]);
  assert.equal((eight.layout.root as any).children[1].children.length, 6);
  for (const d of [zero, one, two, five, eight]) {
    const ps = panes(d.layout.root);
    assert.equal(d.layout.focusedPaneId, ps[0].paneId, "anchor pane focused"); assert.equal(ps[0].content.threadId, "anchor");
    assert.ok(ps.every((p) => /^pane-ws-/.test(p.paneId) && p.content.projectId === "pa"), "fresh pane ids and project from the index");
    assert.equal(new Set(ps.map((p) => p.paneId)).size, ps.length, "unique pane ids");
    assert.ok(!ids(d).some((id) => id.startsWith("g")), "no grandchildren placed");
  }
  assert.equal(G.deriveGroupLayout("nope", tree(2)), null);
});

test("create switches: record written from the group (not current panes), then the switch transaction saves departing → apply → commit", () => {
  const departing = single("pa", "unrelated", "p-live");
  L.saveLayout("project:pa", single("pa", "old"));
  L.setActive("pa", "project:pa");
  const derived = G.deriveGroupLayout("anchor", tree(1))!;
  const record = L.createThreadWorkspace("anchor", { projectId: "pa", parentThreadId: null, title: "Anchor" }, derived.layout);
  assert.deepEqual(record.layout, derived.layout);
  assert.notDeepEqual(record.layout, departing, "record does not capture the current panes");
  assert.equal(L.currentKey(L.readStore()), "project:pa", "not yet active before the transaction");
  const calls: string[] = [];
  const outcome = S.runSwitch({
    saveDeparting: () => { calls.push("save"); L.saveLayout("project:pa", departing); },
    apply: () => { calls.push("apply"); return true; },
    commit: () => { calls.push("commit"); L.setActive("pa", "thread:anchor"); L.touchThreadWorkspace("anchor", 99); },
  });
  assert.equal(outcome.status, "applied"); assert.deepEqual(calls, ["save", "apply", "commit"]);
  const store = L.readStore();
  assert.deepEqual(store.layouts["project:pa"], departing, "departing panes saved under the old key");
  assert.deepEqual(store.layouts["thread:anchor"], derived.layout, "group layout intact");
  assert.equal(L.currentKey(store), "thread:anchor");
});

test("reset: re-derives an existing (broken) record with the 0.3.2 rules, keeping the previous layout recoverable", () => {
  const broken = single("pa", "unrelated");
  L.createThreadWorkspace("anchor", { projectId: "pa", parentThreadId: null, title: "Anchor" }, broken);
  const record = L.threadWorkspace(L.readStore(), "anchor")!;
  const derived = G.deriveGroupLayout("anchor", tree(3))!;
  assert.equal(L.saveLayout(record.key, derived.layout, { baseRevision: record.revision }), true);
  const after = L.threadWorkspace(L.readStore(), "anchor")!;
  assert.deepEqual(after.layout, derived.layout); assert.deepEqual(after.previous, broken); assert.equal(after.revision, 2);
  assert.deepEqual(panes(after.layout.root).map((p) => p.content.threadId), ["anchor", "c3", "c2", "c1"]);
  assert.equal((after.layout.root as any).children[0].content.threadId, "anchor", "anchor left, children stacked right");
});

test("clobber guard: no group thread → skip; anchor or a direct child → save; grandchild alone does not count; no index → anchor alone", () => {
  const threads = tree(3);
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "unrelated"), threads), false);
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "cousin"), threads), false, "same project, outside the group");
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "g1"), threads), false, "grandchild belongs to c1's workspace");
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "c2"), threads), true, "a direct child alone is enough");
  const mixed = { root: { type: "split", dir: "row", sizes: [0.5, 0.5], children: [single("pa", "unrelated", "x").root, single("pa", "c1", "y").root] }, focusedPaneId: "x" } as any;
  assert.equal(G.snapshotBelongsToGroup("anchor", mixed, threads), true, "mixed arrangement with one group thread saves");
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "anchor"), []), true, "without an index the anchor still counts");
  assert.equal(G.snapshotBelongsToGroup("anchor", single("pa", "c1"), []), false, "without an index a child cannot be verified");
});
