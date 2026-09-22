import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./dom.ts";

const dom = installDom();
const M = await import("../lib/membership.ts");
const { watchThreadClicks } = await import("../lib/thread-click.ts");

beforeEach(() => dom.reset());

const threads = [
  { id: "root", parentThreadId: null },
  { id: "mid", parentThreadId: "root" },
  { id: "leaf", parentThreadId: "mid" },
  { id: "lone", parentThreadId: null },
  { id: "loopA", parentThreadId: "loopB" },
  { id: "loopB", parentThreadId: "loopA" },
];
const anchors = new Set(["root", "mid"]);

test("membership: deepest workspace wins; anchor counts as a member; non-members resolve to null; cycles terminate", () => {
  assert.equal(M.deepestWorkspaceFor("leaf", anchors, threads), "mid");
  assert.equal(M.deepestWorkspaceFor("mid", anchors, threads), "mid");
  assert.equal(M.deepestWorkspaceFor("root", anchors, threads), "root");
  assert.equal(M.deepestWorkspaceFor("lone", anchors, threads), null);
  assert.equal(M.deepestWorkspaceFor("loopA", anchors, threads), null);
  assert.equal(M.deepestWorkspaceFor("leaf", new Set(["root"]), threads), "root", "falls back to the nearest ancestor workspace");
});

test("resolveMemberClick: switches to the deepest containing workspace; active-key short-circuit; setting off; other project", () => {
  const base = { threadId: "leaf", projectId: "pa", activeProjectId: "pa", activeKey: "project:pa", workspaceAnchors: anchors, threads, enabled: true };
  assert.equal(M.resolveMemberClick(base), "thread:mid");
  assert.equal(M.resolveMemberClick({ ...base, activeKey: "thread:mid" }), null, "already on screen → default click");
  assert.equal(M.resolveMemberClick({ ...base, activeKey: "thread:root" }), "thread:mid", "a shallower active workspace still switches to the deepest");
  assert.equal(M.resolveMemberClick({ ...base, enabled: false }), null, "setting off restores 0.3.1 behavior");
  assert.equal(M.resolveMemberClick({ ...base, threadId: "lone" }), null, "not inside any thread workspace");
  assert.equal(M.resolveMemberClick({ ...base, activeProjectId: "pb" }), null, "other project is the cross-project path");
});

test("thread-click: plain member click intercepts with the key; modifier and middle clicks pass through; non-member same-project click passes through", () => {
  document.body.innerHTML = [
    '<div><a id="leaf" data-sidebar-thread-id="leaf" href="/projects/pa/threads/leaf"></a><span></span></div>',
    '<div><a id="lone" data-sidebar-thread-id="lone" href="/projects/pa/threads/lone"></a><span></span></div>',
    '<div><a id="other" data-sidebar-thread-id="x" href="/projects/pb/threads/x"></a><span></span></div>',
  ].join("");
  const calls: unknown[] = [];
  const dispose = watchThreadClicks(document, () => "pa",
    (projectId, threadId, key) => calls.push([projectId, threadId, key ?? null]),
    (projectId, threadId) => (projectId === "pa" && threadId === "leaf" ? "thread:mid" : null));
  const click = (id: string, init: MouseEventInit = {}) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    document.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(click("leaf"), true, "member click intercepted"); assert.deepEqual(calls.at(-1), ["pa", "leaf", "thread:mid"]);
  const before = calls.length;
  assert.equal(click("leaf", { metaKey: true }), false, "Cmd-click passes through");
  assert.equal(click("leaf", { shiftKey: true }), false, "Shift-click passes through");
  assert.equal(click("leaf", { altKey: true }), false, "Alt-click passes through");
  assert.equal(click("leaf", { button: 1 }), false, "middle click passes through");
  assert.equal(calls.length, before, "no activation for modified clicks");
  assert.equal(click("lone"), false, "non-member same-project click is bb's");
  assert.equal(click("other"), true, "cross-project path unchanged"); assert.deepEqual(calls.at(-1), ["pb", "x", null]);
  dispose();
});
