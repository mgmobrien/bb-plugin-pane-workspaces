// bb's real split layout is persisted under `bb.splitLayout` as
// `{ version: 1, layout }` — in sessionStorage first (per window), mirrored
// to localStorage. The host reads it ONCE when the window initializes and
// never subscribes to changes, so adopting a different layout means writing
// both storages and reloading the window.
//
// This is an undocumented host key. The host validates on read, so a bad or
// stale value degrades to bb's default layout rather than a crash.
//
// 0.3.0 — workspaces are keyed, not per project. A key is either
// `project:<projectId>` (the project's default layout; 0.2.x behavior) or
// `thread:<threadId>` (a workspace anchored to a thread at any depth). A thread
// workspace's identity is its key alone: `projectId` and `parentThreadId` on
// the record are display metadata refreshed from the index, so moving or
// re-parenting the thread never orphans or rekeys the workspace.
//
// Storage: `workspaces.v2` in localStorage holds the shared records. Per-window
// state (which project is on screen, and which workspace key each project last
// switched to) lives in sessionStorage under `workspaces.session.v2`; the
// `session` field inside the v2 record is a read-only bootstrap mirror used
// only when a window has no session record yet (first paint), like bb reads
// `bb.splitLayout` session-first. When sessionStorage is unavailable the
// per-window state is kept in memory for the page lifetime and never written
// to localStorage, so it can never redirect another live window's saves.
// Cross-window synchronization is deliberately not attempted in 0.3.0.
//
// Every write is a per-key merge: the map is re-read immediately before the
// write, only the affected keys change, and each record carries a `revision`
// counter. A save whose base revision is older than the stored one is skipped
// with a console warning rather than clobbering the newer record.

export const HOST_LAYOUT_KEY = "bb.splitLayout";
export const HOST_MAXIMIZED_KEY = "bb.splitLayout.maximizedPaneId";
export const STORE_KEY = "workspaces.v2";
export const LEGACY_STORE_KEY = "workspaces.v1";
export const SESSION_KEY = "workspaces.session.v2";
export const STORE_EVENT = "workspaces:changed";

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

/** `project:<id>` or `thread:<id>`. */
export type WorkspaceKey = string;

export function projectKey(projectId: string): WorkspaceKey { return `project:${projectId}`; }
export function threadKey(threadId: string): WorkspaceKey { return `thread:${threadId}`; }
export function parseKey(key: string): { kind: "project"; projectId: string } | { kind: "thread"; threadId: string } | null {
  if (key.startsWith("project:") && key.length > 8) return { kind: "project", projectId: key.slice(8) };
  if (key.startsWith("thread:") && key.length > 7) return { kind: "thread", threadId: key.slice(7) };
  return null;
}

/** Display metadata for a thread workspace; never part of its identity. */
export interface ThreadWorkspaceMeta {
  projectId: string;
  parentThreadId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Most recent switch to this workspace (picker ordering). */
  lastUsedAt: number;
}

/** The assembled record for one thread workspace. */
export interface ThreadWorkspace extends ThreadWorkspaceMeta {
  key: WorkspaceKey;
  threadId: string;
  layout: HostLayout;
  previous?: HostLayout;
  revision: number;
}

/** Per-window state. */
export interface SessionState {
  /** Project whose workspace is on screen (and being auto-saved). */
  active: string | null;
  /** Per project, the workspace key last switched to there. Absent = `project:`. */
  activeKeyByProject: Record<string, WorkspaceKey>;
}

/** Shared records plus this window's session state. */
export interface Store extends SessionState {
  layouts: Record<WorkspaceKey, HostLayout>;
  /** Per key, the layout as it was before the last write that changed or removed it. */
  previous?: Record<WorkspaceKey, HostLayout>;
  /** Thread workspaces by thread id. */
  threads: Record<string, ThreadWorkspaceMeta>;
  /** Per key write counter; absent means 0. */
  revisions: Record<WorkspaceKey, number>;
}

interface PersistedStore {
  version: 2;
  layouts: Record<WorkspaceKey, HostLayout>;
  previous?: Record<WorkspaceKey, HostLayout>;
  threads: Record<string, ThreadWorkspaceMeta>;
  revisions: Record<WorkspaceKey, number>;
  /** Bootstrap mirror of the last session state written by any window. */
  session?: SessionState;
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

// ---------------------------------------------------------------------------
// Session state (per window)

type SessionWindow = Window & { __bbWorkspacesSession?: SessionState; __bbWorkspacesSessionWarned?: boolean };

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.active === null || typeof v.active === "string") &&
    typeof v.activeKeyByProject === "object" && v.activeKeyByProject !== null;
}

function cleanSession(value: unknown): SessionState {
  if (!isSessionState(value)) return { active: null, activeKeyByProject: {} };
  const activeKeyByProject: Record<string, WorkspaceKey> = {};
  for (const [id, key] of Object.entries(value.activeKeyByProject)) if (typeof key === "string" && parseKey(key)) activeKeyByProject[id] = key;
  return { active: value.active, activeKeyByProject };
}

function sessionStorageOrNull(): Storage | null {
  try {
    const storage = window.sessionStorage;
    // Access can throw (sandboxed frames, disabled storage); probe once.
    storage.getItem(SESSION_KEY);
    return storage;
  } catch {
    const win = window as SessionWindow;
    if (!win.__bbWorkspacesSessionWarned) {
      win.__bbWorkspacesSessionWarned = true;
      console.warn("Workspaces: sessionStorage is unavailable; the active workspace is kept in memory for this page only.");
    }
    return null;
  }
}

/** Session record first; the localStorage mirror only bootstraps a window that has none. */
export function readSession(): SessionState {
  const win = window as SessionWindow;
  const storage = sessionStorageOrNull();
  if (!storage) return win.__bbWorkspacesSession ??= { active: null, activeKeyByProject: {} };
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (raw) return cleanSession(JSON.parse(raw));
  } catch {
    console.warn("Workspaces: could not read the window's session state");
  }
  const bootstrap = cleanSession(readPersisted().session);
  // Persisting the bootstrap makes later mirror writes from other windows inert here.
  try { storage.setItem(SESSION_KEY, JSON.stringify(bootstrap)); } catch { /* keep going with the in-memory copy */ }
  return bootstrap;
}

function writeSession(state: SessionState): void {
  const win = window as SessionWindow;
  const storage = sessionStorageOrNull();
  if (!storage) {
    // In-memory only: never mirror to localStorage from a window without session scope.
    win.__bbWorkspacesSession = state;
    return;
  }
  storage.setItem(SESSION_KEY, JSON.stringify(state));
  // Mirror for first paint of a later window. Live windows read their own
  // session record first, so this cannot redirect their saves.
  const persisted = readPersisted();
  persisted.session = state;
  writePersisted(persisted);
}

// ---------------------------------------------------------------------------
// Persisted store (shared)

function cleanMeta(value: unknown): ThreadWorkspaceMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.projectId !== "string") return null;
  const num = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);
  const createdAt = num(v.createdAt, 0);
  return {
    projectId: v.projectId,
    parentThreadId: typeof v.parentThreadId === "string" ? v.parentThreadId : null,
    title: typeof v.title === "string" ? v.title : "",
    createdAt,
    updatedAt: num(v.updatedAt, createdAt),
    lastUsedAt: num(v.lastUsedAt, createdAt),
  };
}

function cleanPersisted(parsed: Partial<PersistedStore>): PersistedStore {
  const layouts: Record<WorkspaceKey, HostLayout> = {};
  for (const [k, v] of Object.entries(parsed.layouts ?? {})) if (parseKey(k) && isLayout(v)) layouts[k] = v;
  const previous: Record<WorkspaceKey, HostLayout> = {};
  for (const [k, v] of Object.entries(parsed.previous ?? {})) if (parseKey(k) && isLayout(v)) previous[k] = v;
  const threads: Record<string, ThreadWorkspaceMeta> = {};
  for (const [id, v] of Object.entries(parsed.threads ?? {})) {
    const meta = cleanMeta(v);
    // A thread workspace without a layout is not a record.
    if (meta && layouts[threadKey(id)]) threads[id] = meta;
  }
  const revisions: Record<WorkspaceKey, number> = {};
  for (const [k, v] of Object.entries(parsed.revisions ?? {})) if (typeof v === "number" && Number.isFinite(v) && v > 0) revisions[k] = v;
  const store: PersistedStore = { version: 2, layouts, threads, revisions };
  if (Object.keys(previous).length > 0) store.previous = previous;
  if (isSessionState(parsed.session)) store.session = cleanSession(parsed.session);
  return store;
}

/** One-time v1 → v2 conversion. v1 is left in place for rollback. */
function migrateLegacy(raw: string): PersistedStore | null {
  try {
    const parsed = JSON.parse(raw) as { active?: unknown; layouts?: Record<string, unknown>; previous?: Record<string, unknown> };
    const layouts: Record<WorkspaceKey, HostLayout> = {};
    for (const [id, v] of Object.entries(parsed.layouts ?? {})) if (isLayout(v)) layouts[projectKey(id)] = v;
    const previous: Record<WorkspaceKey, HostLayout> = {};
    for (const [id, v] of Object.entries(parsed.previous ?? {})) if (isLayout(v)) previous[projectKey(id)] = v;
    const store: PersistedStore = { version: 2, layouts, threads: {}, revisions: {} };
    if (Object.keys(previous).length > 0) store.previous = previous;
    store.session = { active: typeof parsed.active === "string" ? parsed.active : null, activeKeyByProject: {} };
    return store;
  } catch {
    console.warn("Workspaces: could not migrate workspaces.v1; starting empty");
    return null;
  }
}

function readPersisted(): PersistedStore {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) return cleanPersisted(JSON.parse(raw) as Partial<PersistedStore>);
    const legacy = window.localStorage.getItem(LEGACY_STORE_KEY);
    const migrated = legacy ? migrateLegacy(legacy) : null;
    if (migrated) {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return { version: 2, layouts: {}, threads: {}, revisions: {} };
  } catch {
    return { version: 2, layouts: {}, threads: {}, revisions: {} };
  }
}

function writePersisted(store: PersistedStore): void {
  window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function notify(): void {
  window.dispatchEvent(new Event(STORE_EVENT));
}

export function readStore(): Store {
  const persisted = readPersisted();
  const session = readSession();
  const store: Store = {
    active: session.active,
    activeKeyByProject: session.activeKeyByProject,
    layouts: persisted.layouts,
    threads: persisted.threads,
    revisions: persisted.revisions,
  };
  if (persisted.previous) store.previous = persisted.previous;
  return store;
}

/** The key whose layout is on screen for `projectId`: its remembered thread workspace, else `project:`. */
export function activeKeyFor(store: Store, projectId: string): WorkspaceKey {
  const remembered = store.activeKeyByProject[projectId];
  if (remembered) {
    const parsed = parseKey(remembered);
    if (parsed?.kind === "thread" && store.threads[parsed.threadId] && store.layouts[remembered]) return remembered;
  }
  return projectKey(projectId);
}

/** The key being auto-saved right now, if a project is active. */
export function currentKey(store: Store): WorkspaceKey | null {
  return store.active ? activeKeyFor(store, store.active) : null;
}

export function threadWorkspace(store: Store, threadId: string): ThreadWorkspace | null {
  const meta = store.threads[threadId];
  const key = threadKey(threadId);
  const layout = store.layouts[key];
  if (!meta || !layout) return null;
  const record: ThreadWorkspace = { ...meta, key, threadId, layout, revision: store.revisions[key] ?? 0 };
  const previous = store.previous?.[key];
  if (previous) record.previous = previous;
  return record;
}

export function threadWorkspaces(store: Store, projectId?: string): ThreadWorkspace[] {
  return Object.keys(store.threads)
    .map((id) => threadWorkspace(store, id))
    .filter((r): r is ThreadWorkspace => r !== null && (!projectId || r.projectId === projectId));
}

// ---------------------------------------------------------------------------
// Per-key writes

export interface SaveOptions {
  /** Revision the caller read; a newer stored revision rejects the save. */
  baseRevision?: number;
}

/** Save one key's layout. Returns false when a newer revision is already stored. */
export function saveLayout(key: WorkspaceKey, layout: HostLayout, options: SaveOptions = {}): boolean {
  if (!parseKey(key)) throw new Error(`Workspaces: invalid workspace key ${key}`);
  const persisted = readPersisted();
  const stored = persisted.revisions[key] ?? 0;
  if (options.baseRevision !== undefined && stored > options.baseRevision) {
    console.warn(`Workspaces: skipped saving ${key}; stored revision ${stored} is newer than base ${options.baseRevision}`);
    return false;
  }
  const was = persisted.layouts[key];
  if (was && JSON.stringify(was) !== JSON.stringify(layout)) {
    persisted.previous = { ...(persisted.previous ?? {}), [key]: was };
  }
  persisted.layouts[key] = layout;
  persisted.revisions[key] = stored + 1;
  const meta = parseKey(key);
  if (meta?.kind === "thread" && persisted.threads[meta.threadId]) persisted.threads[meta.threadId].updatedAt = Date.now();
  writePersisted(persisted);
  notify();
  return true;
}

/** Create (or re-create) a thread workspace from a layout. Identity is the thread id only. */
export function createThreadWorkspace(threadId: string, meta: Pick<ThreadWorkspaceMeta, "projectId" | "parentThreadId" | "title">, layout: HostLayout, now = Date.now()): ThreadWorkspace {
  const key = threadKey(threadId);
  const persisted = readPersisted();
  const existing = persisted.threads[threadId];
  const was = persisted.layouts[key];
  if (was && JSON.stringify(was) !== JSON.stringify(layout)) persisted.previous = { ...(persisted.previous ?? {}), [key]: was };
  persisted.layouts[key] = layout;
  persisted.revisions[key] = (persisted.revisions[key] ?? 0) + 1;
  persisted.threads[threadId] = {
    projectId: meta.projectId,
    parentThreadId: meta.parentThreadId,
    title: meta.title,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: now,
  };
  writePersisted(persisted);
  notify();
  return threadWorkspace(readStore(), threadId)!;
}

/** Refresh display metadata only; the record and its layout are untouched. */
export function updateThreadMeta(threadId: string, patch: Partial<Pick<ThreadWorkspaceMeta, "projectId" | "parentThreadId" | "title">>): boolean {
  const persisted = readPersisted();
  const meta = persisted.threads[threadId];
  if (!meta) return false;
  let changed = false;
  if (patch.projectId !== undefined && meta.projectId !== patch.projectId) { meta.projectId = patch.projectId; changed = true; }
  if (patch.parentThreadId !== undefined && meta.parentThreadId !== patch.parentThreadId) { meta.parentThreadId = patch.parentThreadId; changed = true; }
  if (patch.title !== undefined && meta.title !== patch.title) { meta.title = patch.title; changed = true; }
  if (!changed) return false;
  writePersisted(persisted);
  notify();
  return true;
}

/** Record a switch to a thread workspace (picker MRU order). */
export function touchThreadWorkspace(threadId: string, now = Date.now()): void {
  const persisted = readPersisted();
  const meta = persisted.threads[threadId];
  if (!meta) return;
  meta.lastUsedAt = now;
  writePersisted(persisted);
  notify();
}

/** Remove one key. Project keys keep a recovery copy; thread records are dropped whole. */
export function forgetWorkspace(key: WorkspaceKey): void {
  const parsed = parseKey(key);
  if (!parsed) return;
  const persisted = readPersisted();
  const was = persisted.layouts[key];
  delete persisted.layouts[key];
  delete persisted.revisions[key];
  if (parsed.kind === "project") {
    if (was) persisted.previous = { ...(persisted.previous ?? {}), [key]: was };
  } else {
    delete persisted.threads[parsed.threadId];
    if (persisted.previous) { delete persisted.previous[key]; if (Object.keys(persisted.previous).length === 0) delete persisted.previous; }
  }
  writePersisted(persisted);
  // A window remembering this thread workspace falls back to its project key.
  const session = readSession();
  let sessionChanged = false;
  for (const [projectId, remembered] of Object.entries(session.activeKeyByProject)) {
    if (remembered === key) { delete session.activeKeyByProject[projectId]; sessionChanged = true; }
  }
  if (sessionChanged) writeSession(session);
  notify();
}

/** Commit this window's active project and the key it shows. */
export function setActive(projectId: string | null, key?: WorkspaceKey): void {
  const session = readSession();
  session.active = projectId;
  if (projectId && key) {
    const parsed = parseKey(key);
    if (parsed?.kind === "thread") session.activeKeyByProject[projectId] = key;
    else delete session.activeKeyByProject[projectId];
  }
  writeSession(session);
  notify();
}

/** Move a remembered thread key from one project to another (thread moved projects). */
export function rebindActiveKey(key: WorkspaceKey, fromProjectId: string, toProjectId: string): void {
  const session = readSession();
  if (session.activeKeyByProject[fromProjectId] !== key) return;
  delete session.activeKeyByProject[fromProjectId];
  session.activeKeyByProject[toProjectId] = key;
  if (session.active === fromProjectId) session.active = toProjectId;
  writeSession(session);
  notify();
}

// ---------------------------------------------------------------------------
// Layout helpers

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
  // 'workspaces' is the pre-rename id (0.3.3 and earlier); keep it so migrated
  // layouts that still reference it are treated the same.
  const ids = ['pane-workspaces', 'workspaces', 'compact-panes', 'thread-nicknames', 'sidebar-organizer'];
  if (ids.some(id => pathname.replace(/\/+$/, '') === `/settings/plugins/${id}`)) return true;
  return !!layout && panesOf(layout.root).some(({ content }) =>
    (content.kind === 'plugin-panel' || content.kind === 'plugin-detail') && ids.includes(content.pluginId));
}
