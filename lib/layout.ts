// bb's real split layout is persisted under `bb.splitLayout` as
// `{ version: 1, layout }` — in sessionStorage first (per window), mirrored
// to localStorage. The host reads it ONCE when the window initializes and
// never subscribes to changes, so adopting a different layout means writing
// both storages and reloading the window.
//
// This is an undocumented host key. The host validates on read, so a bad or
// stale value degrades to bb's default layout rather than a crash.

export const HOST_LAYOUT_KEY = "bb.splitLayout";
export const HOST_MAXIMIZED_KEY = "bb.splitLayout.maximizedPaneId";
export const STORE_KEY = "workspaces.v1";

export type PaneContent =
  | { kind: "thread"; projectId: string; threadId: string }
  | { kind: "new-thread" }
  | { kind: "plugin-panel"; pluginId: string; panelPath: string; subPath: string }
  | { kind: "plugin-detail"; pluginId: string };

export type LayoutNode =
  | { type: "pane"; paneId: string; content: PaneContent }
  | { type: "split"; dir: "row" | "col"; sizes: number[]; children: LayoutNode[] };

export interface HostLayout {
  root: LayoutNode;
  focusedPaneId: string;
}

export interface Store {
  /** Project whose layout is currently on screen (and being auto-saved). */
  active: string | null;
  layouts: Record<string, HostLayout>;
  /** Per project, the layout as it was before the last write that changed or removed it. */
  previous?: Record<string, HostLayout>;
}

export function panesOf(node: LayoutNode): Extract<LayoutNode, { type: "pane" }>[] {
  return node.type === "pane" ? [node] : node.children.flatMap(panesOf);
}

function isLayout(value: unknown): value is HostLayout {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.focusedPaneId === "string" && typeof v.root === "object" && v.root !== null;
}

export function readHostLayout(): HostLayout | null {
  try {
    const raw =
      window.sessionStorage.getItem(HOST_LAYOUT_KEY) ?? window.localStorage.getItem(HOST_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; layout?: unknown };
    return parsed.version === 1 && isLayout(parsed.layout) ? parsed.layout : null;
  } catch {
    return null;
  }
}

function setBoth(key: string, value: string): void {
  window.sessionStorage.setItem(key, value);
  window.localStorage.setItem(key, value);
}

/**
 * Persist a layout where the host will read it on its next initialization.
 * The caller reloads the window afterwards; nothing here takes effect live.
 */
export function writeHostLayout(layout: HostLayout): void {
  setBoth(HOST_LAYOUT_KEY, JSON.stringify({ version: 1, layout }));
  // A maximized pane would mask the new arrangement; empty reads as "none".
  setBoth(HOST_MAXIMIZED_KEY, "");
}

/** Match bb's routes. New-thread deliberately uses the legacy project route:
 * its host redirect seeds the composer project before navigating to /. */
export function routeFor(layout: HostLayout, projectId: string): string {
  const content = panesOf(layout.root).find((p) => p.paneId === layout.focusedPaneId)?.content;
  if (content?.kind === "thread") return content.projectId === "proj_personal"
    ? `/threads/${content.threadId}` : `/projects/${content.projectId}/threads/${content.threadId}`;
  if (content?.kind === "plugin-detail") return `/plugins/${encodeURIComponent(content.pluginId)}`;
  if (content?.kind === "plugin-panel") {
    const root = `/plugins/${encodeURIComponent(content.pluginId)}/${encodeURIComponent(content.panelPath)}`;
    const sub = content.subPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return sub ? `${root}/${sub}` : root;
  }
  return `/projects/${projectId}`;
}

/** Includes bb's compose redirect and legacy personal-thread links. */
export function routeMatchesLayout(pathname: string, layout: HostLayout, projectId: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === routeFor(layout, projectId)) return true;
  const content = panesOf(layout.root).find((p) => p.paneId === layout.focusedPaneId)?.content;
  if (content?.kind === "new-thread") return path === "/";
  return content?.kind === "thread" && content.projectId === "proj_personal" &&
    path === `/projects/proj_personal/threads/${content.threadId}`;
}

export function readStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return { active: null, layouts: {} };
    const parsed = JSON.parse(raw) as Partial<Store>;
    const layouts: Record<string, HostLayout> = {};
    for (const [k, v] of Object.entries(parsed.layouts ?? {})) if (isLayout(v)) layouts[k] = v;
    const previous: Record<string, HostLayout> = {};
    for (const [k, v] of Object.entries(parsed.previous ?? {})) if (isLayout(v)) previous[k] = v;
    const store: Store = { active: typeof parsed.active === "string" ? parsed.active : null, layouts };
    if (Object.keys(previous).length > 0) store.previous = previous;
    return store;
  } catch {
    return { active: null, layouts: {} };
  }
}

export function writeStore(store: Store): void {
  // Per project: whenever a project's layout changes or is removed, retain what
  // it was. Other projects' recovery points are untouched by that write.
  const current = readStore();
  const previous: Record<string, HostLayout> = { ...(current.previous ?? {}) };
  for (const [id, was] of Object.entries(current.layouts)) {
    const now = store.layouts[id];
    if (!now || JSON.stringify(now) !== JSON.stringify(was)) previous[id] = was;
  }
  const next: Store = { active: store.active, layouts: store.layouts };
  if (Object.keys(previous).length > 0) next.previous = previous;
  window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("workspaces:changed"));
}

/** The project a layout "belongs to": the focused pane's, else the first thread pane's. */
export function projectOf(layout: HostLayout): string | null {
  const panes = panesOf(layout.root);
  const focused = panes.find((p) => p.paneId === layout.focusedPaneId);
  const pick = (p: (typeof panes)[number] | undefined) =>
    p && p.content.kind === "thread" ? p.content.projectId : null;
  return pick(focused) ?? panes.map(pick).find((id) => id !== null) ?? null;
}

export function focusedThreadId(layout: HostLayout): string | null {
  const focused = panesOf(layout.root).find((p) => p.paneId === layout.focusedPaneId);
  return focused && focused.content.kind === "thread" ? focused.content.threadId : null;
}

let counter = 0;
export function newPaneId(): string {
  counter += 1;
  return `pane-ws-${Date.now().toString(36)}${counter}`;
}

export function singlePane(content: PaneContent): HostLayout {
  const paneId = newPaneId();
  return { root: { type: "pane", paneId, content }, focusedPaneId: paneId };
}

/** Replace thread panes whose thread no longer exists with a new-thread pane. */
export function sanitize(layout: HostLayout, liveThreadIds: ReadonlySet<string>): HostLayout {
  const fix = (node: LayoutNode): LayoutNode => {
    if (node.type === "split") return { ...node, children: node.children.map(fix) };
    if (node.content.kind === "thread" && !liveThreadIds.has(node.content.threadId)) {
      return { ...node, content: { kind: "new-thread" } };
    }
    return node;
  };
  return { ...layout, root: fix(layout.root) };
}

export function sameLayout(a: HostLayout | null, b: HostLayout | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Select in the destination workspace without disturbing an existing pane. */
export function selectThread(layout: HostLayout, projectId: string, threadId: string): HostLayout {
  const panes = panesOf(layout.root);
  const existing = panes.find((pane) => pane.content.kind === "thread" &&
    pane.content.projectId === projectId && pane.content.threadId === threadId);
  if (existing) return { ...layout, focusedPaneId: existing.paneId };
  const focusedPaneId = panes.find((pane) => pane.paneId === layout.focusedPaneId)?.paneId ?? panes[0]?.paneId;
  if (!focusedPaneId) return singlePane({ kind: "thread", projectId, threadId });
  const replace = (node: LayoutNode): LayoutNode => node.type === "split"
    ? { ...node, children: node.children.map(replace) }
    : node.paneId === focusedPaneId
      ? { ...node, content: { kind: "thread", projectId, threadId } }
      : node;
  return { ...layout, root: replace(layout.root), focusedPaneId };
}

/** Management pages are transient controls, not a project's saved work. */
export function isWorkspaceControlLayout(layout: HostLayout | null, pathname = ''): boolean {
  const ids = ['workspaces', 'compact-panes', 'thread-nicknames'];
  if (ids.some(id => pathname.replace(/\/+$/, '') === `/settings/plugins/${id}`)) return true;
  return !!layout && panesOf(layout.root).some(({ content }) =>
    (content.kind === 'plugin-panel' || content.kind === 'plugin-detail') && ids.includes(content.pluginId));
}
