// 0.3.4: bb's built-in "Threads" section (the personal project, proj_personal)
// behaves as its own workspace. jsdom, using the host markup shape from
// TopLevelSidebarSection.tsx (no [data-sidebar-project-id] wrapper, no
// data-sidebar-section-id) and ProjectRow.tsx.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./dom.ts";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const dom = installDom();
const { watchThreadClicks } = await import("../lib/thread-click.ts");
const SB = await import("../lib/sidebar.ts");
const P = await import("../lib/preview.ts");
const { decorateActiveHeading } = await import("../lib/active-heading.ts");

beforeEach(() => dom.reset());

const row = (projectId: string, id: string) => {
  const href = projectId === "proj_personal" ? `/threads/${id}` : `/projects/${projectId}/threads/${id}`;
  return `<div id="row-${id}" style="padding-left:8px"><a id="${id}" data-sidebar-thread-id="${id}" href="${href}"></a><span><span title="${id}">${id}</span></span></div>`;
};
const heading = (id: string, label: string) => `<div data-sidebar-sticky-tier="label" id="heading-${id}">
  <span><span title="${label}" id="title-${id}">${label}</span><button type="button" aria-label="Collapse ${label} section"></button></span>
  <span data-sidebar-trailing-controls="" id="controls-${id}"><span><button type="button">…</button></span></span></div>`;
const builtIn = (id: string, label: string, rows: string) =>
  `<div data-sidebar-sticky-group="" id="group-${id}">${heading(id, label)}<div class="mt-1">${rows}</div></div>`;
const project = (id: string, name: string, rows: string) =>
  `<div data-sidebar-sticky-project-item="" data-sidebar-project-id="${id}" id="group-${id}"><div data-sidebar-sticky-group="">${heading(id, name)}<div>${rows}</div></div></div>`;
const sidebar = (inner: string) => `<div data-sidebar="sidebar"><div data-sidebar-sticky-stack=""><div data-sidebar="group-content"><div class="space-y-4">${inner}</div></div></div></div>`;
function render(extra = "") {
  document.body.innerHTML = sidebar([
    builtIn("pinned", "Pinned", row("proj_alpha", "pinned-a")),
    project("proj_alpha", "Alpha", row("proj_alpha", "a1")),
    builtIn("threads", "Threads", row("proj_personal", "t1") + row("proj_personal", "t2")),
    extra,
  ].join(""));
}
const click = (id: string, init: MouseEventInit = {}) => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  document.getElementById(id)!.dispatchEvent(event);
  return event.defaultPrevented;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("personal click: switches to project:proj_personal when another project is active; bb's navigation when personal is active; modifiers untouched", () => {
  render();
  const calls: unknown[] = [];
  let active: string | null = "proj_alpha";
  const dispose = watchThreadClicks(document, () => active, (projectId, threadId, key) => calls.push([projectId, threadId, key ?? null]));
  assert.equal(click("t1"), true, "personal thread click intercepted while Alpha is on screen");
  assert.deepEqual(calls.at(-1), ["proj_personal", "t1", null], "cross-project path with proj_personal");
  assert.equal(click("a1"), false, "same-project Alpha click stays bb's");
  const before = calls.length;
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }]) {
    assert.equal(click("t2", init), false, `modified click passes through: ${JSON.stringify(init)}`);
  }
  assert.equal(calls.length, before);
  active = "proj_personal";
  assert.equal(click("t2"), false, "already in the personal workspace → plain navigation");
  assert.equal(click("a1"), true, "from personal, an Alpha click is the cross-project path");
  assert.deepEqual(calls.at(-1), ["proj_alpha", "a1", null]);
  active = null;
  assert.equal(click("t2"), true, "no active project: a personal click still switches (as any project click does)");
  dispose();
});

test("personal member click: a thread workspace under a personal thread resolves through memberTarget with proj_personal", () => {
  render();
  const calls: unknown[] = [];
  const dispose = watchThreadClicks(document, () => "proj_personal",
    (projectId, threadId, key) => calls.push([projectId, threadId, key ?? null]),
    (projectId, threadId) => (projectId === "proj_personal" && threadId === "t2" ? "thread:t1" : null));
  assert.equal(click("t2"), true); assert.deepEqual(calls.at(-1), ["proj_personal", "t2", "thread:t1"]);
  assert.equal(click("t1"), false, "not a member of an off-screen workspace → bb's click");
  dispose();
});

test("section detection: the built-in Threads heading is proj_personal; Pinned and project items are not; a foreign-linked Threads section is ignored", () => {
  render();
  const threads = SB.personalSection(document)!;
  assert.equal(threads.id, "group-threads");
  assert.equal(SB.sectionProjectId(threads), "proj_personal");
  assert.equal(SB.sectionOf(document.getElementById("t1")!), threads);
  assert.equal(SB.sectionOf(document.getElementById("pinned-a")!), null, "Pinned is not a workspace group");
  assert.equal(SB.sectionOf(document.getElementById("a1")!)?.id, "group-proj_alpha");
  assert.deepEqual(SB.sidebarProjectIds(document), ["proj_alpha"], "hotkey order stays project-only (no hotkey changes)");
  // Machine mode: a Threads section listing other projects' threads is not the personal project.
  document.body.innerHTML = sidebar(builtIn("threads", "Threads", row("proj_personal", "t1") + row("proj_alpha", "a9")));
  assert.equal(SB.personalSection(document), null);
  // A Threads group that bb later tags with data-sidebar-section-id is left to the project path.
  render();
  document.getElementById("group-threads")!.setAttribute("data-sidebar-section-id", "threads");
  assert.equal(SB.personalSection(document), null);
});

test("heading targets: a mount lands in the Threads heading's trailing controls (rightmost), none in Pinned; removal and re-render reconcile", async () => {
  render();
  let latest: { projectId: string; container: HTMLElement }[] = [];
  const dispose = SB.watchProjectTargets(document, (targets) => { latest = targets; });
  assert.deepEqual(latest.map((t) => t.projectId), ["proj_alpha", "proj_personal"]);
  const personal = latest.find((t) => t.projectId === "proj_personal")!;
  assert.equal(personal.container.parentElement, document.getElementById("controls-threads"), "mounted inside the Threads heading's trailing controls");
  assert.equal(document.getElementById("controls-threads")!.lastElementChild, personal.container, "rightmost slot");
  assert.equal(document.querySelectorAll("#group-pinned [data-workspace-mount]").length, 0, "Pinned gets no button");
  // Active marking uses the same decorate path as project headings.
  const undo = decorateActiveHeading(personal.container);
  assert.equal(document.getElementById("heading-threads")!.hasAttribute("data-workspace-active"), true);
  assert.equal(document.getElementById("heading-pinned")!.hasAttribute("data-workspace-active"), false);
  undo();
  assert.equal(document.getElementById("heading-threads")!.hasAttribute("data-workspace-active"), false);
  // Host removes the section (no personal threads left): the target goes away.
  document.getElementById("group-threads")!.remove();
  await tick();
  assert.deepEqual(latest.map((t) => t.projectId), ["proj_alpha"]);
  assert.equal(personal.container.isConnected, false);
  dispose();
  assert.equal(document.querySelectorAll("[data-workspace-mount]").length, 0);
});

test("heading name click: a plain click on the Threads label activates; the chevron, controls and modified clicks do not", () => {
  render();
  let latest: { projectId: string; container: HTMLElement }[] = [];
  const dispose = SB.watchProjectTargets(document, (targets) => { latest = targets; });
  const personal = latest.find((t) => t.projectId === "proj_personal")!;
  let activated = 0;
  const off = SB.listenForProjectNameClick(personal.container, () => { activated += 1; });
  assert.equal(click("title-threads"), true); assert.equal(activated, 1);
  assert.equal(click("title-threads", { metaKey: true }), false); assert.equal(activated, 1);
  assert.equal(click("title-pinned"), false, "Pinned label is not wired"); assert.equal(activated, 1);
  document.querySelector<HTMLElement>('#heading-threads button[aria-label]')!.click();
  assert.equal(activated, 1, "chevron click is bb's");
  off(); dispose();
});

test("preview: project preview for proj_personal marks the Threads heading and its rows only; a personal thread preview marks its subtree", () => {
  render(row("proj_personal", "stray"));
  const marked = P.markPreview(document, { kind: "project", projectId: "proj_personal" }).map((el) => el.id);
  assert.deepEqual(marked, ["heading-threads", "row-t1", "row-t2"]);
  assert.equal(document.getElementById("heading-threads")!.hasAttribute("data-workspace-preview-anchor"), true);
  P.clearPreview(document);
  assert.deepEqual(P.markPreview(document, { kind: "project", projectId: "proj_alpha" }).map((el) => el.id), ["heading-proj_alpha", "row-a1"]);
  P.clearPreview(document);
  document.getElementById("row-t2")!.style.paddingLeft = "32px"; // t2 nested under t1
  assert.deepEqual(P.markPreview(document, { kind: "thread", threadId: "t1" }).map((el) => el.id), ["row-t1", "row-t2"]);
  P.clearPreview(document);
  assert.deepEqual(P.markPreview(document, { kind: "thread", threadId: "stray" }), [], "a personal row outside the section is not a group member");
  assert.equal(document.querySelectorAll("[data-workspace-preview]").length, 0);
});

test("index: the personal project is listed as \"Threads (no project)\" (the picker and Workspaces page render index names)", async () => {
  const host = createFakePluginHost({ pluginId: "workspaces", sdk: {
    subscribe: () => () => {},
    projects: { list: async () => [{ id: "proj_personal", name: "Personal", kind: "personal" }, { id: "proj_alpha", name: "Alpha", kind: "standard" }] as never },
    threads: { list: async () => [], get: async () => { throw new Error("unused"); } },
  } });
  await plugin(host.bb);
  try {
    const index = await host.harness.behavior.callRpc("index", null) as { projects: Array<{ id: string; name: string; kind: string }> };
    assert.deepEqual(index.projects, [{ id: "proj_personal", name: "Threads (no project)", kind: "personal" }, { id: "proj_alpha", name: "Alpha", kind: "standard" }]);
  } finally { await host.harness.lifecycle.dispose(); }
});
