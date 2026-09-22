import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, single } from "./dom.ts";

const dom = installDom();
const L = await import("../lib/layout.ts");
const S = await import("../lib/switching.ts");

beforeEach(() => dom.reset());

test("order: save departing → apply → commit; failed apply leaves both layouts and the active key unchanged", () => {
  const from = single("pa", "t1"), to = single("pa", "t2");
  L.saveLayout("project:pa", from);
  L.createThreadWorkspace("t2", { projectId: "pa", parentThreadId: null, title: "Two" }, to);
  L.setActive("pa", "project:pa");
  const departing = single("pa", "t1", "p-live"); // what is on screen now
  const calls: string[] = [];
  const outcome = S.runSwitch({
    saveDeparting: () => { calls.push("save"); L.saveLayout("project:pa", departing); },
    apply: () => { calls.push("apply"); throw new Error("host refused"); },
    commit: () => { calls.push("commit"); L.setActive("pa", "thread:t2"); },
  });
  assert.equal(outcome.status, "failed");
  assert.deepEqual(calls, ["save", "apply"], "commit never runs after a failed apply");
  const store = L.readStore();
  assert.deepEqual(store.layouts["project:pa"], departing, "departing layout saved under the OLD key");
  assert.deepEqual(store.layouts["thread:t2"], to, "destination untouched");
  assert.equal(L.currentKey(store), "project:pa", "active key unchanged");
  assert.equal(S.isTransitioning(), false, "guard released");
  // A false return is a failure too.
  const again = S.runSwitch({ saveDeparting() {}, apply: () => false, commit: () => assert.fail("must not commit") });
  assert.equal(again.status, "failed");
});

test("success commits after apply; snapshots are suppressed during the transition", () => {
  const calls: string[] = [];
  let during = false;
  const outcome = S.runSwitch({
    saveDeparting: () => calls.push("save"),
    apply: () => { during = S.isTransitioning(); calls.push("apply"); return true; },
    commit: () => calls.push("commit"),
  });
  assert.equal(outcome.status, "applied");
  assert.deepEqual(calls, ["save", "apply", "commit"]);
  assert.equal(during, true, "guard held while applying");
  assert.equal(S.isTransitioning(), false);
  // keepGuard leaves the guard for the reload path, and the safety timeout releases it.
  S.runSwitch({ saveDeparting() {}, apply: () => true, commit() {} }, { keepGuard: true });
  assert.equal(S.isTransitioning(), true);
  S.endTransition();
  assert.equal(S.isTransitioning(), false);
});
