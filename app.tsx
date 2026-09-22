import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchThreadClicks } from "./lib/thread-click";
import { decorateActiveHeading } from "./lib/active-heading";
import "./workspace.css";
import { hideBrowserPreviewsForReload } from "./lib/browser-preview";
import { acceptLayoutHandoff, allowSaving, canSave, needsSavingChoice, prepareLayoutHandoff, savingEvent } from "./lib/saving";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "./lib/portal-scope";
import { watchProjectTargets, listenForProjectNameClick, sidebarProjectIds, shortcutIndex, shortcutLabel, type ProjectTarget } from "./lib/sidebar";
import { watchThreadRows, type RowAction, type RowState, type ThreadRowTarget } from "./lib/thread-rows";
import { clearPreview, markPreview } from "./lib/preview";
import { endTransition, isTransitioning, runSwitch } from "./lib/switching";
import { reconcileThreadWorkspaces } from "./lib/cleanup";
import { breadcrumbFor, matchesQuery, orderByMostRecentlyUsed } from "./lib/picker";
import { deriveGroupLayout, snapshotBelongsToGroup } from "./lib/group-layout";
import * as sdk from "@get-bb/plugin-sdk/app";
import { definePluginApp, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { deepestWorkspaceFor, resolveMemberClick } from "./lib/membership";
import type { IndexProject, IndexThread, rpcContract } from "./server";
import {
  activeKeyFor,
  createThreadWorkspace,
  currentKey,
  forgetWorkspace,
  isWorkspaceControlLayout,
  parseKey,
  projectKey,
  projectOf,
  readHostLayout,
  readStore,
  rebindActiveKey,
  routeFor,
  sameLayout,
  sanitize,
  saveLayout,
  selectThread,
  setActive,
  singlePane,
  STORE_EVENT,
  threadKey,
  threadWorkspace,
  threadWorkspaces,
  touchThreadWorkspace,
  updateThreadMeta,
  writeHostLayout,
  type HostLayout,
  type Store,
  type ThreadWorkspace,
  type WorkspaceKey,
} from "./lib/layout";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_MS = 1000;

/** Latest index threads, for the snapshot clobber guard (module-level: snapshot runs outside React). */
let latestThreads: IndexThread[] = [];
const clobberWarned = new Set<string>();
/** `memberClickSwitches` setting mirror for the DOM click handler. */
let memberClickEnabled = true;

// Present only on hosts that ship the split-layout SDK hook. Resolved once per
// runtime load, so branching on it below is stable for the rules of hooks.
type SplitLayoutHook = () => {
  layout: HostLayout | null;
  isAvailable: boolean;
  setLayout(next: HostLayout): boolean;
};
const sdkSurface = sdk as unknown as { experimental_useSplitLayout?: unknown };
const useHostSplitLayout: SplitLayoutHook | null =
  typeof sdkSurface.experimental_useSplitLayout === "function"
    ? (sdkSurface.experimental_useSplitLayout as SplitLayoutHook)
    : null;
const unavailableHost = { layout: null, isAvailable: false, setLayout: () => false };
const useOptionalHostSplitLayout: SplitLayoutHook = useHostSplitLayout ?? (() => unavailableHost);

/** Save the on-screen layout under the active workspace key (deriving the project if unset). */
function snapshot(): void {
  if (isTransitioning()) return; // (d) never snapshot mid-switch
  const layout = readHostLayout();
  if (!layout || isWorkspaceControlLayout(layout, window.location.pathname)) return;
  const store = readStore();
  const project = store.active ?? projectOf(layout);
  if (!project) return;
  const key = store.active ? activeKeyFor(store, project) : projectKey(project);
  acceptLayoutHandoff();
  if (!canSave(key)) {
    if (store.layouts[key]) return;
    allowSaving(key); // New workspace: no saved layout can be overwritten.
  }
  if (store.active === project && sameLayout(store.layouts[key] ?? null, layout)) return;
  const anchor = parseKey(key);
  if (anchor?.kind === "thread" && !snapshotBelongsToGroup(anchor.threadId, layout, latestThreads)) {
    // 0.3.1 clobber guard: panes showing none of this group are not this workspace.
    if (!clobberWarned.has(key)) {
      clobberWarned.add(key);
      console.warn(`Workspaces: not saving panes to ${key}; none of them show a thread from its group`);
    }
    return;
  }
  clobberWarned.delete(key);
  if (store.active !== project) setActive(project, key);
  saveLayout(key, layout, { baseRevision: store.revisions[key] ?? 0 });
}

function useIndex() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<IndexProject[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<IndexThread[]>([]);
  const refetch = useCallback(() => {
    rpc.call("index").then((r) => {
      latestThreads = r.threads;
      setProjects(r.projects);
      setThreads(r.threads);
      setReady(true);
      setError(null);
    }, () => { setError("Could not load workspaces. Try again shortly."); });
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("index", refetch);
  return { rpc, projects, threads, ready, error };
}

function defaultLayoutFor(projectId: string, threads: IndexThread[]): HostLayout {
  const candidates = threads
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
  const first = candidates[0];
  return singlePane(first ? { kind: "thread", projectId, threadId: first.id } : { kind: "new-thread" });
}

export interface SwitchRequest {
  key: WorkspaceKey;
  projectId: string;
  /** Select this thread in the destination (cross-project row click). */
  threadId?: string;
  /** Use this layout instead of the saved one (Restore previous). */
  recovery?: HostLayout;
}

function useWorkspaces() {
  const { rpc, projects: indexProjects, threads, ready, error } = useIndex();
  const [sidebarIds, setSidebarIds] = useState(() => sidebarProjectIds(document));
  useEffect(() => {
    const refresh = () => setSidebarIds(sidebarProjectIds(document));
    refresh();
    window.addEventListener("workspaces:sidebar-changed", refresh);
    return () => window.removeEventListener("workspaces:sidebar-changed", refresh);
  }, []);
  const shortcutIds = useMemo(() => sidebarIds.filter((id) => indexProjects.some((p) => p.id === id)), [sidebarIds, indexProjects]);
  const projects = useMemo(() => [...indexProjects].sort((a, b) => {
    const ai = shortcutIds.indexOf(a.id), bi = shortcutIds.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }), [indexProjects, shortcutIds]);
  const host = useOptionalHostSplitLayout();
  const settings = useSettings();
  const memberClickSwitches = settings.values?.memberClickSwitches !== false;
  useEffect(() => { memberClickEnabled = memberClickSwitches; }, [memberClickSwitches]);
  const [store, setStore] = useState<Store>(readStore);
  const [, refreshSaving] = useState(0);
  useEffect(() => {
    const refresh = () => refreshSaving((n) => n + 1);
    window.addEventListener(savingEvent(), refresh);
    return () => window.removeEventListener(savingEvent(), refresh);
  }, []);
  useEffect(() => {
    snapshot();
    const refresh = () => setStore(readStore());
    refresh();
    window.addEventListener(STORE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(STORE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const liveIds = useMemo(() => new Set(threads.map((t) => t.id)), [threads]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [threads]);

  const switchTo = useCallback((request: SwitchRequest) => {
    const { key, projectId, threadId, recovery } = request;
    // A clicked row supplies authoritative ids even before the RPC index loads.
    if (!threadId && (!ready || error)) return;
    const current = readStore();
    const onScreen = current.active === projectId && currentKey(current) === key;
    if (!recovery && onScreen && canSave(key) && !isWorkspaceControlLayout(readHostLayout(), window.location.pathname)) {
      return;
    }
    clearPreview(document);
    const saved = current.layouts[key];
    const base = recovery ?? saved ?? defaultLayoutFor(projectId, threads);
    // Preserve unknown panes until the index is available. The clicked row is
    // authoritative even if its thread has not appeared in the index yet.
    const cleaned = ready && !error
      ? sanitize(base, threadId ? new Set([...liveIds, threadId]) : liveIds)
      : base;
    const target = threadId
      ? selectThread(cleaned, projectId, threadId)
      : cleaned;
    const anchor = parseKey(key);
    const applied = { mode: "reload" as "instant" | "reload" };
    const outcome = runSwitch({
      saveDeparting: snapshot,
      apply: () => {
        if (useHostSplitLayout && host.isAvailable && host.setLayout(target)) {
          // Instant path: the host validated, normalized, applied, and routed.
          applied.mode = "instant";
          return true;
        }
        hideBrowserPreviewsForReload(window); // throws → nothing is committed
        writeHostLayout(target);
        prepareLayoutHandoff(key, target);
        return true;
      },
      commit: () => {
        setActive(projectId, key);
        saveLayout(key, target, { baseRevision: current.revisions[key] ?? 0 });
        if (anchor?.kind === "thread") touchThreadWorkspace(anchor.threadId);
        if (applied.mode === "instant") allowSaving(key);
      },
    }, { keepGuard: true });
    if (outcome.status === "failed") {
      endTransition();
      console.error("Workspace switch stopped before applying", outcome.cause);
      const reason = outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause);
      window.alert(`Could not switch workspace: ${reason}. Nothing was changed. Use bb’s View > Reload, then try again.`);
      return;
    }
    if (applied.mode === "instant") {
      endTransition();
      setStore(readStore());
      return;
    }
    window.history.replaceState(null, "", routeFor(target, projectId));
    window.location.reload();
  }, [ready, error, threads, liveIds, host.isAvailable, host.setLayout]);

  const forgetProject = (projectId: string) => {
    forgetWorkspace(projectKey(projectId));
    setStore(readStore());
  };

  /** Create a thread workspace from its nesting group (anchor + descendants) and switch to it. */
  const makeThreadWorkspace = useCallback((projectId: string, threadId: string, fallbackTitle?: string) => {
    if (!ready || error) { window.alert("Workspaces is still loading the thread index. Try again in a moment."); return; }
    const derived = deriveGroupLayout(threadId, threads);
    if (!derived) { window.alert("This thread is not in the workspace index yet. Try again in a moment."); return; }
    const indexed = threads.find((t) => t.id === threadId);
    createThreadWorkspace(threadId, {
      projectId: indexed?.projectId ?? projectId,
      parentThreadId: indexed?.parentThreadId ?? null,
      title: indexed?.title ?? fallbackTitle ?? threadId,
    }, derived.layout);
    if (derived.omitted.length > 0) console.info(`Workspaces: ${threadId} has ${derived.placed.length - 1 + derived.omitted.length} nested threads; only the first six were placed.`);
    // The switch transaction saves the departing panes under the old key, then applies the group.
    switchTo({ key: threadKey(threadId), projectId: indexed?.projectId ?? projectId });
  }, [threads, ready, error, switchTo]);

  /** Re-derive an existing thread workspace from its group (repairs records captured from unrelated panes). */
  const resetThreadWorkspace = useCallback((threadId: string) => {
    if (!ready || error) return;
    const record = threadWorkspace(readStore(), threadId);
    const derived = deriveGroupLayout(threadId, threads);
    if (!record || !derived) { window.alert("Could not derive this workspace's group from the thread index."); return; }
    if (derived.omitted.length > 0) console.info(`Workspaces: ${threadId} has ${derived.placed.length - 1 + derived.omitted.length} nested threads; only the first six were placed.`);
    const current = readStore();
    if (current.active === record.projectId && currentKey(current) === record.key) {
      // On screen: apply through the switch transaction so the panes follow.
      switchTo({ key: record.key, projectId: record.projectId, recovery: derived.layout });
      return;
    }
    saveLayout(record.key, derived.layout, { baseRevision: record.revision });
    setStore(readStore());
  }, [threads, ready, error, switchTo]);

  const forgetThreadWorkspace = useCallback((threadId: string) => {
    forgetWorkspace(threadKey(threadId));
    // Saving falls back to `project:`; its saved panes stay protected until
    // the Restore/Keep choice, exactly as any other unmatched layout.
    setStore(readStore());
  }, []);

  const savingPaused = needsSavingChoice() && !isWorkspaceControlLayout(readHostLayout(), window.location.pathname);
  const useCurrentLayout = () => {
    const key = currentKey(store);
    if (!key) return;
    allowSaving(key);
    snapshot();
  };
  return { rpc, projects, threads, shortcutIds, store, counts, ready, error, switchTo, forgetProject, makeThreadWorkspace, forgetThreadWorkspace, resetThreadWorkspace, savingPaused, useCurrentLayout, memberClickSwitches, settingsLoading: settings.isLoading };
}

/** Palette actions run outside React; the overlay publishes its handlers here. */
const controller: { current: null | {
  switchTo(request: SwitchRequest): void;
  make(projectId: string | null, threadId: string): void;
  forget(threadId: string): void;
  reset(threadId: string): void;
} } = { current: null };

function rowStateFor(store: Store, threadId: string): RowState {
  const record = threadWorkspace(store, threadId);
  if (!record) return "candidate";
  return store.active === record.projectId && currentKey(store) === record.key ? "active" : "workspace";
}

interface ThreadEntry { record: ThreadWorkspace; breadcrumb: string[]; }

function useThreadEntries(store: Store, projects: IndexProject[], threads: IndexThread[]): Map<string, ThreadEntry[]> {
  return useMemo(() => {
    const byProject = new Map<string, ThreadEntry[]>();
    for (const record of orderByMostRecentlyUsed(threadWorkspaces(store))) {
      const name = projects.find((p) => p.id === record.projectId)?.name ?? record.projectId;
      const entry = { record, breadcrumb: breadcrumbFor(record, threads, name) };
      byProject.set(record.projectId, [...(byProject.get(record.projectId) ?? []), entry]);
    }
    return byProject;
  }, [store, projects, threads]);
}

function Switcher({ dismiss, page = false }: { dismiss(): void; page?: boolean }) {
  const { projects, threads, shortcutIds, store, counts, ready, error, switchTo, forgetProject, forgetThreadWorkspace, resetThreadWorkspace } = useWorkspaces();
  const [query, setQuery] = useState("");
  const entries = useThreadEntries(store, projects, threads);
  const activeKey = currentKey(store);
  return (
    <div className={cn("flex flex-col overflow-y-auto p-1", page ? "max-h-none" : "max-h-96")}>
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      <input
        type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspaces…"
        aria-label="Search workspaces" autoFocus={!page}
        onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
        className="mx-1 mb-1 rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {error ? <div role="alert" className="px-2 py-3 text-sm">{error}</div> : !ready ? (
        <div className="px-2 py-3 text-sm text-muted-foreground">Loading…</div>
      ) : (
        projects.map((p) => {
          const index = shortcutIds.indexOf(p.id);
          const pKey = projectKey(p.id);
          const projectActive = store.active === p.id && activeKey === pKey;
          const saved = pKey in store.layouts;
          const children = (entries.get(p.id) ?? []).filter((entry) => matchesQuery(entry, query));
          const showProject = matchesQuery({ breadcrumb: [p.name] }, query) || children.length > 0;
          if (!showProject) return null;
          return (
            <div key={p.id}>
              <div className="group flex items-center">
                <button
                  type="button"
                  onClick={() => { switchTo({ key: pKey, projectId: p.id }); dismiss(); }}
                  onPointerEnter={() => markPreview(document, { kind: "project", projectId: p.id })}
                  onPointerLeave={() => clearPreview(document)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                    projectActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                >
                  <Icon
                    name={p.kind === "personal" ? "UserRound" : "FolderOpen"}
                    className="size-4 flex-none text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {saved ? (
                    <Icon name="Layers" className="size-3.5 flex-none text-muted-foreground" aria-label="Has a saved layout" />
                  ) : null}
                  <span className="flex-none text-[10px] text-muted-foreground">{index >= 0 && index < 9 ? shortcutLabel(index) : ""}</span>
                  <span className="w-5 flex-none text-right text-[10px] text-muted-foreground" title="Threads">{counts.get(p.id) ?? 0}</span>
                  {page ? <span className="flex-none rounded border px-1.5 text-[11px]">{projectActive ? "Active" : "Switch"}</span> : null}
                </button>
                {store.previous?.[pKey] ? (
                  <button type="button" title="Restore previous layout" disabled={!ready || !!error}
                    aria-label={`Restore previous layout for ${p.name}`}
                    onClick={() => { switchTo({ key: pKey, projectId: p.id, recovery: store.previous?.[pKey] }); dismiss(); }}
                    className="size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                    ↶
                  </button>
                ) : null}
                {saved && !projectActive ? (
                  <button
                    type="button"
                    title="Forget saved layout"
                    aria-label={`Forget saved layout for ${p.name}`}
                    onClick={() => forgetProject(p.id)}
                    className="invisible size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:visible"
                  >
                    <Icon name="Minimize2" className="mx-auto size-3.5" />
                  </button>
                ) : null}
              </div>
              {children.map(({ record, breadcrumb }) => {
                const active = store.active === record.projectId && activeKey === record.key;
                const label = breadcrumb.slice(1).join(" › ");
                return (
                  <div key={record.key} className="group flex items-center pl-4">
                    <button
                      type="button"
                      title={breadcrumb.join(" › ")}
                      onClick={() => { switchTo({ key: record.key, projectId: record.projectId }); dismiss(); }}
                      onPointerEnter={() => markPreview(document, { kind: "thread", threadId: record.threadId })}
                      onPointerLeave={() => clearPreview(document)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none",
                        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <Icon name="GridView" className="size-3.5 flex-none text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {page ? <span className="flex-none rounded border px-1.5 text-[11px]">{active ? "Active" : "Switch"}</span> : null}
                    </button>
                    {record.previous ? (
                      <button type="button" title="Restore previous layout" disabled={!ready || !!error}
                        aria-label={`Restore previous layout for ${label}`}
                        onClick={() => { switchTo({ key: record.key, projectId: record.projectId, recovery: record.previous }); dismiss(); }}
                        className="size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                        ↶
                      </button>
                    ) : null}
                    <button type="button" title="Reset this workspace to its group" disabled={!ready || !!error}
                      aria-label={`Reset workspace for ${label} to its group`}
                      onClick={() => resetThreadWorkspace(record.threadId)}
                      className={cn("size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground", page ? "" : "invisible group-hover:visible")}>
                      ↺
                    </button>
                    <button
                      type="button"
                      title="Forget workspace"
                      aria-label={`Forget workspace for ${label}`}
                      onClick={() => forgetThreadWorkspace(record.threadId)}
                      className={cn("size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground", page ? "" : "invisible group-hover:visible")}
                    >
                      <Icon name="Minimize2" className="mx-auto size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

function WorkspaceOverlay() {
  const { rpc, projects, threads, shortcutIds, store, ready, error, switchTo, makeThreadWorkspace, forgetThreadWorkspace, resetThreadWorkspace, savingPaused, useCurrentLayout } = useWorkspaces();
  const [targets, setTargets] = useState<ProjectTarget[]>([]);
  const scope = usePortalScopeProps();
  const switchRef = useRef(switchTo);
  switchRef.current = switchTo;
  const makeRef = useRef(makeThreadWorkspace);
  makeRef.current = makeThreadWorkspace;
  const forgetRef = useRef(forgetThreadWorkspace);
  forgetRef.current = forgetThreadWorkspace;
  const resetRef = useRef(resetThreadWorkspace);
  resetRef.current = resetThreadWorkspace;
  useEffect(() => {
    controller.current = {
      reset: (threadId) => resetRef.current(threadId),
      switchTo: (request) => switchRef.current(request),
      make: (projectId, threadId) => {
        const fallback = projectId ?? readStore().active ?? (() => { const l = readHostLayout(); return l ? projectOf(l) : null; })();
        if (!fallback) return;
        makeRef.current(fallback, threadId);
      },
      forget: (threadId) => forgetRef.current(threadId),
    };
    return () => { controller.current = null; };
  }, []);
  // Row clicks. Cross-project: that project's remembered workspace with the
  // thread selected. Same project (0.3.2): a member of a thread workspace not
  // on screen switches to the deepest containing workspace with the thread
  // selected; otherwise bb's plain navigation. 0.3.4: the built-in Threads
  // section is project `proj_personal` for both paths (lib/thread-click.ts).
  useEffect(() => watchThreadClicks(document,
    () => readStore().active ?? (() => { const layout = readHostLayout(); return layout ? projectOf(layout) : null; })(),
    (projectId, threadId, key) => {
      // 0.3.3: a cross-project click on a member of a thread workspace lands in
      // that workspace (deepest containing), not the project's remembered one.
      const store = readStore();
      const member = memberClickEnabled ? deepestWorkspaceFor(threadId, new Set(Object.keys(store.threads)), latestThreads) : null;
      switchRef.current({ key: key ?? (member ? threadKey(member) : activeKeyFor(store, projectId)), projectId, threadId });
    },
    (projectId, threadId) => {
      const store = readStore();
      return resolveMemberClick({
        threadId, projectId, activeProjectId: store.active, activeKey: currentKey(store),
        workspaceAnchors: new Set(Object.keys(store.threads)), threads: latestThreads, enabled: memberClickEnabled,
      });
    },
  ), []);
  // Heading grid buttons: every project heading plus the built-in Threads
  // section (0.3.4; lib/sidebar.ts personalSection). Pinned is never a target.
  useEffect(() => watchProjectTargets(document, (next) => {
    setTargets(next);
    window.dispatchEvent(new Event("workspaces:sidebar-changed"));
  }), []);
  // Thread-row controls. Clicking a thread never switches (see README); only the icon does.
  useEffect(() => {
    let cached: Store | null = null;
    const storeNow = () => cached ??= readStore();
    const invalidate = () => { cached = null; };
    const watcher = watchThreadRows(document, {
      stateOf: (threadId) => rowStateFor(storeNow(), threadId),
      activate: (target: ThreadRowTarget, action: RowAction) => {
        clearPreview(document);
        if (action === "create") {
          const title = target.row.querySelector<HTMLElement>("[title]")?.getAttribute("title") ?? undefined;
          makeRef.current(target.projectId, target.threadId, title);
        } else if (action === "forget") {
          forgetRef.current(target.threadId);
        } else {
          const record = threadWorkspace(readStore(), target.threadId);
          if (record) switchRef.current({ key: record.key, projectId: record.projectId });
        }
      },
      preview: (target) => target ? markPreview(document, { kind: "thread", threadId: target.threadId }) : clearPreview(document),
    });
    const refresh = () => { invalidate(); watcher.refresh(); };
    window.addEventListener(STORE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(savingEvent(), refresh);
    return () => {
      window.removeEventListener(STORE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(savingEvent(), refresh);
      watcher.dispose();
      clearPreview(document);
    };
  }, []);
  // Thread workspace upkeep: refresh display metadata; drop records only after
  // two consecutive index misses AND server confirmation.
  const missesRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!ready || error) return;
    const records = threadWorkspaces(readStore()).map(({ threadId, projectId, parentThreadId, title }) => ({ threadId, projectId, parentThreadId, title }));
    if (records.length === 0) { missesRef.current.clear(); return; }
    const result = reconcileThreadWorkspaces(records, threads, missesRef.current);
    missesRef.current = result.misses;
    for (const change of result.changes) {
      updateThreadMeta(change.threadId, change.patch);
      if (change.projectChanged && change.patch.projectId) rebindActiveKey(threadKey(change.threadId), change.fromProjectId, change.patch.projectId);
    }
    if (result.candidates.length === 0) return;
    let cancelled = false;
    rpc.call("threadsGone", { threadIds: result.candidates.slice(0, 100) }).then(({ gone }) => {
      if (cancelled) return;
      for (const threadId of gone) { forgetWorkspace(threadKey(threadId)); missesRef.current.delete(threadId); }
    }, (cause) => console.warn("Workspaces: could not confirm removed threads; keeping their workspaces", cause));
    return () => { cancelled = true; };
  }, [rpc, threads, ready, error]);
  useEffect(() => {
    const target = targets.find(({ projectId }) => projectId === store.active);
    return target ? decorateActiveHeading(target.container) : undefined;
  }, [targets, store.active]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = shortcutIndex(event);
      if (index === null || !ready || error || !shortcutIds[index]) return;
      event.preventDefault();
      event.stopPropagation();
      switchTo({ key: projectKey(shortcutIds[index]), projectId: shortcutIds[index] });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutIds, ready, error, switchTo]);
  useEffect(() => {
    if (!ready || error) return;
    const dispose = targets
      .filter(({ projectId }) => projects.some((project) => project.id === projectId))
      .map(({ projectId, container }) => listenForProjectNameClick(container, () => switchTo({ key: projectKey(projectId), projectId })));
    return () => { for (const cleanup of dispose) cleanup(); };
  }, [targets, projects, ready, error, switchTo]);
  const activeKey = currentKey(store);
  const activeAnchor = activeKey ? parseKey(activeKey) : null;
  const activeLabel = (() => {
    const project = projects.find((p) => p.id === store.active)?.name ?? "Current workspace";
    if (activeAnchor?.kind !== "thread") return project;
    const record = threadWorkspace(store, activeAnchor.threadId);
    return record ? `${project} › ${record.title || record.threadId}` : project;
  })();
  return <>
    {savingPaused ? <div {...scope} role="status" className="fixed bottom-4 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
      <span>{activeLabel}: saved panes protected — changes aren’t being saved yet</span>
      <button type="button" disabled={!ready || !!error} className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50" onClick={() => store.active && activeKey && switchTo({ key: activeKey, projectId: store.active })}>Restore saved panes</button>
      <button type="button" className="rounded px-2 py-1 hover:bg-accent" onClick={useCurrentLayout}>Keep current panes</button>
    </div> : null}
    {targets.map(({ projectId, container }) => {
    const index = shortcutIds.indexOf(projectId);
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    const label = `Switch to ${project.name} workspace${index >= 0 && index < 9 ? ` (${shortcutLabel(index)})` : ""}`;
    const pressed = store.active === projectId && activeKey === projectKey(projectId);
    return createPortal(
      <span {...scope} className="inline-flex items-center">
        <button data-workspace-grid="" type="button" title={error ?? label} aria-label={label}
          aria-pressed={pressed} disabled={!ready || !!error}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={() => markPreview(document, { kind: "project", projectId })}
          onPointerLeave={() => clearPreview(document)}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); switchTo({ key: projectKey(projectId), projectId }); }}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-40 max-md:pointer-coarse:size-9">
          <Icon name="GridView" className="size-4" />
        </button>
      </span>, container, projectId,
    );
    })}
  </>;
}

function MemberClickSetting() {
  const { rpc, memberClickSwitches, settingsLoading } = useWorkspaces();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" checked={memberClickSwitches} disabled={settingsLoading || pending}
      onChange={(event) => {
        setPending(true); setFailed(null);
        rpc.call("setMemberClickSwitches", { enabled: event.target.checked }).then(() => setPending(false), (cause) => { setPending(false); setFailed(`Could not save the setting: ${cause instanceof Error ? cause.message : String(cause)}`); });
      }} />
    <span>Clicking a thread in a workspace switches to it</span>
    {failed ? <span role="alert" className="text-destructive">{failed}</span> : null}
  </label>;
}

function WorkspacePage() {
  return <div className="mx-auto w-full max-w-3xl space-y-4 p-5">
    <p className="text-sm text-muted-foreground">Every saved workspace, grouped by project: the project's default layout first, then its thread workspaces (most recently used first). Your saved arrangement is kept while you browse these controls.</p>
    <p className="text-sm text-muted-foreground">In the sidebar, hover a thread and click its grid icon to make it a workspace: its panes are the thread on the left and its direct nested threads stacked on the right (up to six); click the icon again to switch, Shift-click to forget. <b>↺</b> resets a workspace to its group. Hovering a workspace row highlights every thread in it. The command palette offers <b>Workspaces: make current thread a workspace</b>, <b>switch to workspace…</b>, <b>reset this workspace to its group</b> and <b>forget current thread's workspace</b>.</p>
    <MemberClickSetting />
    <Switcher dismiss={() => {}} page />
  </div>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "workspaces", title: "Saved workspaces", component: WorkspacePage });
  app.slots.navPanel({ id: "workspaces", title: "Workspaces", icon: "GridView", path: "workspaces", component: WorkspacePage });
  // Keep the active workspace's saved layout current with whatever is on screen.
  app.contentScripts.register({
    id: "layout-watch",
    mount({ signal }) {
      snapshot();
      const timer = window.setInterval(snapshot, POLL_MS);
      signal.addEventListener("abort", () => window.clearInterval(timer), { once: true });
      return () => window.clearInterval(timer);
    },
  });

  app.slots.experimental_appOverlay({ id: "workspace-controls", component: WorkspaceOverlay });
  const disclosure = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "switcher",
    label: "Workspaces",
    icon: "GridView",
    component: Switcher,
  });
  app.slots.commandPaletteAction({
    id: "switch-workspace", title: "Workspaces: switch to workspace…",
    run: () => disclosure.open(),
  });
  app.slots.commandPaletteAction({
    id: "make-thread-workspace", title: "Workspaces: make current thread a workspace",
    isAvailable: (context) => !!context.threadId && !threadWorkspace(readStore(), context.threadId),
    run: (context) => { if (context.threadId) controller.current?.make(context.projectId, context.threadId); },
  });
  app.slots.commandPaletteAction({
    id: "reset-thread-workspace", title: "Workspaces: reset this workspace to its group",
    isAvailable: (context) => !!context.threadId && !!threadWorkspace(readStore(), context.threadId),
    run: (context) => { if (context.threadId) controller.current?.reset(context.threadId); },
  });
  app.slots.commandPaletteAction({
    id: "forget-thread-workspace", title: "Workspaces: forget current thread's workspace",
    isAvailable: (context) => !!context.threadId && !!threadWorkspace(readStore(), context.threadId),
    run: (context) => { if (context.threadId) controller.current?.forget(context.threadId); },
  });
});
