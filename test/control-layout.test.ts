import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceControlLayout } from "../lib/layout.ts";

const pane = (pluginId: string, kind: "plugin-panel" | "plugin-detail" = "plugin-panel") =>
  ({ root: { type: "pane", paneId: "p1", content: { kind, pluginId } }, focusedPaneId: "p1" }) as any;
const thread = () => ({ root: { type: "pane", paneId: "p1", content: { kind: "thread", projectId: "proj_x", threadId: "thr_x" } }, focusedPaneId: "p1" }) as any;

test("settings routes for the control plugins are excluded, new id included", () => {
  for (const id of ["pane-workspaces", "workspaces", "compact-panes", "thread-nicknames", "sidebar-organizer"]) {
    assert.equal(isWorkspaceControlLayout(thread(), `/settings/plugins/${id}`), true, id);
    assert.equal(isWorkspaceControlLayout(thread(), `/settings/plugins/${id}/`), true, id + " trailing slash");
  }
  assert.equal(isWorkspaceControlLayout(thread(), "/settings/plugins/some-other-plugin"), false);
  assert.equal(isWorkspaceControlLayout(thread(), "/projects/proj_x/threads/thr_x"), false);
});

test("plugin panes for the control plugins are excluded, others are not", () => {
  assert.equal(isWorkspaceControlLayout(pane("pane-workspaces"), "/"), true);
  assert.equal(isWorkspaceControlLayout(pane("pane-workspaces", "plugin-detail"), "/"), true);
  assert.equal(isWorkspaceControlLayout(pane("workspaces"), "/"), true);
  assert.equal(isWorkspaceControlLayout(pane("compact-panes"), "/"), true);
  assert.equal(isWorkspaceControlLayout(pane("some-other-plugin"), "/"), false);
  assert.equal(isWorkspaceControlLayout(thread(), "/"), false);
  assert.equal(isWorkspaceControlLayout(null, "/"), false);
});
