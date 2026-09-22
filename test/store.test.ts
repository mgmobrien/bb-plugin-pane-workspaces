import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, single } from "./dom.ts";

const dom = installDom();
const L = await import("../lib/layout.ts");
const C = await import("../lib/cleanup.ts");

beforeEach(() => dom.reset());

test("migration: v1 → v2 on first read, idempotent, v1 untouched", () => {
  const a = single("pa", "t1"), b = single("pb", "t2"), prevA = single("pa", "t0");
  const v1 = JSON.stringify({ active: "pa", layouts: { pa: a, pb: b }, previous: { pa: prevA } });
  window.localStorage.setItem(L.LEGACY_STORE_KEY, v1);
  const store = L.readStore();
  assert.deepEqual(store.layouts, { "project:pa": a, "project:pb": b });
  assert.deepEqual(store.previous, { "project:pa": prevA });
  assert.equal(store.active, "pa", "active project bootstraps the window session");
  assert.deepEqual(store.threads, {});
  assert.equal(window.localStorage.getItem(L.LEGACY_STORE_KEY), v1, "v1 is left in place for rollback");
  const v2 = window.localStorage.getItem(L.STORE_KEY)!;
  assert.ok(v2, "v2 written on first read");
  // Idempotent: a later v1 change is ignored once v2 exists.
  window.localStorage.setItem(L.LEGACY_STORE_KEY, JSON.stringify({ active: "pb", layouts: { pb: b } }));
  assert.deepEqual(L.readStore().layouts, { "project:pa": a, "project:pb": b });
  assert.equal(window.localStorage.getItem(L.STORE_KEY), v2);
  assert.equal(JSON.parse(v2).version, 2);
});

test("key resolution: remembered thread key per project, fallback to project:", () => {
  const layout = single("pa", "t1");
  L.saveLayout("project:pa", layout);
  const empty = L.readStore();
  assert.equal(L.activeKeyFor(empty, "pa"), "project:pa");
  L.createThreadWorkspace("t1", { projectId: "pa", parentThreadId: null, title: "One" }, layout);
  L.setActive("pa", "thread:t1");
  let store = L.readStore();
  assert.equal(L.activeKeyFor(store, "pa"), "thread:t1");
  assert.equal(L.activeKeyFor(store, "pb"), "project:pb", "other projects unaffected");
  assert.equal(L.currentKey(store), "thread:t1");
  // Switching to the project key clears the memory.
  L.setActive("pa", "project:pa");
  store = L.readStore();
  assert.equal(L.activeKeyFor(store, "pa"), "project:pa");
  // Remembered key whose record is gone falls back.
  L.setActive("pa", "thread:t1");
  L.forgetWorkspace("thread:t1");
  store = L.readStore();
  assert.equal(L.activeKeyFor(store, "pa"), "project:pa");
  assert.deepEqual(store.activeKeyByProject, {});
});

test("thread workspace: create, record shape, forget leaves the thread and project layout alone", () => {
  const project = single("pa", "t9"), layout = single("pa", "t1");
  L.saveLayout("project:pa", project);
  const record = L.createThreadWorkspace("t1", { projectId: "pa", parentThreadId: "t0", title: "Child" }, layout, 1000);
  assert.deepEqual(record, { key: "thread:t1", threadId: "t1", projectId: "pa", parentThreadId: "t0", title: "Child", layout, createdAt: 1000, updatedAt: 1000, lastUsedAt: 1000, revision: 1 });
  assert.equal(L.threadWorkspaces(L.readStore(), "pa").length, 1);
  // Re-create keeps createdAt, bumps revision and keeps the previous layout.
  const layout2 = single("pa", "t1", "p2");
  const again = L.createThreadWorkspace("t1", { projectId: "pa", parentThreadId: "t0", title: "Child" }, layout2, 2000);
  assert.equal(again.createdAt, 1000); assert.equal(again.revision, 2); assert.deepEqual(again.previous, layout);
  L.forgetWorkspace("thread:t1");
  const store = L.readStore();
  assert.equal(L.threadWorkspace(store, "t1"), null);
  assert.equal(store.layouts["thread:t1"], undefined);
  assert.equal(store.previous?.["thread:t1"], undefined, "thread records are dropped whole");
  assert.deepEqual(store.layouts["project:pa"], project, "project layout untouched");
});

test("project forget stays recoverable via previous (0.2.x behavior)", () => {
  const a = single("pa", "t1");
  L.saveLayout("project:pa", a);
  L.forgetWorkspace("project:pa");
  assert.deepEqual(L.readStore().previous, { "project:pa": a });
});

test("session precedence: sessionStorage wins; localStorage mirror only bootstraps a fresh window", () => {
  L.saveLayout("project:pa", single("pa", "t1"));
  L.createThreadWorkspace("t1", { projectId: "pa", parentThreadId: null, title: "One" }, single("pa", "t1"));
  L.setActive("pa", "thread:t1");
  const mirror = JSON.parse(window.localStorage.getItem(L.STORE_KEY)!).session;
  assert.deepEqual(mirror, { active: "pa", activeKeyByProject: { pa: "thread:t1" } }, "mirror written alongside the session");
  // Another window later writes a different mirror; this window keeps its own session.
  const persisted = JSON.parse(window.localStorage.getItem(L.STORE_KEY)!);
  persisted.session = { active: "pb", activeKeyByProject: {} };
  window.localStorage.setItem(L.STORE_KEY, JSON.stringify(persisted));
  assert.equal(L.readStore().active, "pa");
  assert.equal(L.activeKeyFor(L.readStore(), "pa"), "thread:t1");
  // A fresh window (no session record) bootstraps from the mirror once, then owns its copy.
  window.sessionStorage.clear();
  assert.equal(L.readStore().active, "pb");
  assert.ok(window.sessionStorage.getItem(L.SESSION_KEY), "bootstrap persisted to the window session");
  persisted.session = { active: "pc", activeKeyByProject: {} };
  window.localStorage.setItem(L.STORE_KEY, JSON.stringify(persisted));
  assert.equal(L.readStore().active, "pb", "later mirror changes are inert for a live window");
});

test("sessionStorage unavailable: in-memory active state, warns once, never writes localStorage active state", () => {
  L.saveLayout("project:pa", single("pa", "t1"));
  const before = window.localStorage.getItem(L.STORE_KEY)!;
  const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  const warnings: string[] = [];
  const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    L.setActive("pa", "project:pa");
    L.setActive("pb");
    assert.equal(L.readStore().active, "pb", "in-memory state is honored for this page");
    assert.equal(window.localStorage.getItem(L.STORE_KEY), before, "localStorage untouched (no session mirror)");
    assert.equal(warnings.filter((w) => w.includes("sessionStorage is unavailable")).length, 1, "warned exactly once");
  } finally {
    console.warn = warn;
    Object.defineProperty(window, "sessionStorage", original);
  }
});

test("per-key merge: a concurrent writer to a different key is preserved", () => {
  const a = single("pa", "t1");
  L.saveLayout("project:pa", a);
  const read = L.readStore();
  // Another window writes project:pb between this window's read and write.
  const other = JSON.parse(window.localStorage.getItem(L.STORE_KEY)!);
  const b = single("pb", "t2");
  other.layouts["project:pb"] = b; other.revisions["project:pb"] = 7;
  window.localStorage.setItem(L.STORE_KEY, JSON.stringify(other));
  const a2 = single("pa", "t1", "p3");
  assert.equal(L.saveLayout("project:pa", a2, { baseRevision: read.revisions["project:pa"] }), true);
  const after = L.readStore();
  assert.deepEqual(after.layouts["project:pb"], b, "other key preserved");
  assert.equal(after.revisions["project:pb"], 7);
  assert.deepEqual(after.layouts["project:pa"], a2);
  assert.equal(after.revisions["project:pa"], 2);
  assert.deepEqual(after.previous, { "project:pa": a });
});

test("stale revision: a save whose base is older than the stored revision is rejected, not clobbered", () => {
  const a = single("pa", "t1");
  L.saveLayout("project:pa", a);
  const stale = L.readStore(); // revision 1
  const newer = single("pa", "t1", "p2");
  L.saveLayout("project:pa", newer); // revision 2 (another window)
  const warnings: string[] = [];
  const warn = console.warn; console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    assert.equal(L.saveLayout("project:pa", single("pa", "t1", "p3"), { baseRevision: stale.revisions["project:pa"] }), false);
  } finally { console.warn = warn; }
  assert.deepEqual(L.readStore().layouts["project:pa"], newer, "newer record kept");
  assert.equal(L.readStore().revisions["project:pa"], 2);
  assert.equal(warnings.length, 1);
});

test("identity: a re-parented or moved thread keeps its record; only metadata changes", () => {
  const layout = single("pa", "t1");
  L.createThreadWorkspace("t1", { projectId: "pa", parentThreadId: "root", title: "Child" }, layout, 5);
  L.setActive("pa", "thread:t1");
  const records = () => L.threadWorkspaces(L.readStore()).map(({ threadId, projectId, parentThreadId, title }) => ({ threadId, projectId, parentThreadId, title }));
  // Parent changed only.
  let result = C.reconcileThreadWorkspaces(records(), [{ id: "t1", projectId: "pa", parentThreadId: "other", title: "Child" }], new Map());
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.parentChanged, true); assert.equal(result.changes[0]!.projectChanged, false);
  assert.deepEqual(result.changes[0]!.patch, { parentThreadId: "other" });
  L.updateThreadMeta("t1", result.changes[0]!.patch);
  let record = L.threadWorkspace(L.readStore(), "t1")!;
  assert.equal(record.key, "thread:t1"); assert.equal(record.parentThreadId, "other"); assert.deepEqual(record.layout, layout);
  assert.equal(record.revision, 1, "metadata refresh is not a layout write");
  // Project changed: record survives, active key rebinds to the new project.
  result = C.reconcileThreadWorkspaces(records(), [{ id: "t1", projectId: "pb", parentThreadId: "other", title: "Renamed" }], new Map());
  assert.equal(result.changes[0]!.projectChanged, true); assert.equal(result.changes[0]!.parentChanged, false);
  assert.deepEqual(result.changes[0]!.patch, { projectId: "pb", title: "Renamed" });
  L.updateThreadMeta("t1", result.changes[0]!.patch);
  L.rebindActiveKey("thread:t1", "pa", "pb");
  const store = L.readStore();
  record = L.threadWorkspace(store, "t1")!;
  assert.equal(record.projectId, "pb"); assert.equal(record.title, "Renamed"); assert.equal(record.createdAt, 5);
  assert.deepEqual(store.activeKeyByProject, { pb: "thread:t1" });
  assert.equal(store.active, "pb", "window follows the on-screen workspace to its new project");
  assert.equal(L.activeKeyFor(store, "pa"), "project:pa");
});
