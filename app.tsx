import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchThreadClicks } from "./lib/thread-click";
import { decorateActiveHeading } from "./lib/active-heading";
import "./workspace.css";
import { hideBrowserPreviewsForReload } from "./lib/browser-preview";
import { acceptLayoutHandoff, allowSaving, canSave, needsSavingChoice, prepareLayoutHandoff, savingEvent } from "./lib/saving";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "./lib/portal-scope";
import { watchProjectTargets, listenForProjectNameClick, sidebarProjectIds, shortcutIndex, shortcutLabel, type ProjectTarget } from "./lib/sidebar";
import * as sdk from "@get-bb/plugin-sdk/app";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { IndexProject, IndexThread, rpcContract } from "./server";
import {
  projectOf,
  readHostLayout,
  readStore,
  routeFor,
  sameLayout,
  sanitize,
  selectThread,
  singlePane,
  writeHostLayout,
  writeStore,
  type HostLayout,
} from "./lib/layout";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_MS = 1000;

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

/** Save the on-screen layout under the active project (deriving one if unset). */
function snapshot(): void {
  const layout = readHostLayout();
  if (!layout) return;
  const store = readStore();
  const active = store.active ?? projectOf(layout);
  if (!active) return;
  acceptLayoutHandoff();
  if (!canSave(active)) {
    if (store.layouts[active]) return;
    allowSaving(active); // New workspace: no saved layout can be overwritten.
  }
  if (store.active === active && sameLayout(store.layouts[active] ?? null, layout)) return;
  writeStore({ active, layouts: { ...store.layouts, [active]: layout } });
}

function useIndex() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<IndexProject[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<IndexThread[]>([]);
  const refetch = useCallback(() => {
    rpc.call("index").then((r) => {
      setProjects(r.projects);
      setThreads(r.threads);
      setReady(true);
      setError(null);
    }, () => { setError("Could not load workspaces. Try again shortly."); });
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("index", refetch);
  return { projects, threads, ready, error };
}

function defaultLayoutFor(projectId: string, threads: IndexThread[]): HostLayout {
  const candidates = threads
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
  const first = candidates[0];
  return singlePane(first ? { kind: "thread", projectId, threadId: first.id } : { kind: "new-thread" });
}

function useWorkspaces() {
  const { projects: indexProjects, threads, ready, error } = useIndex();
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
  const [store, setStore] = useState(readStore);
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
    window.addEventListener("workspaces:changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("workspaces:changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const liveIds = useMemo(() => new Set(threads.map((t) => t.id)), [threads]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [threads]);

  const switchTo = useCallback((projectId: string, threadId?: string, recovery?: HostLayout) => {
    // A clicked row supplies authoritative ids even before the RPC index loads.
    if (!threadId && (!ready || error)) return;
    const current = readStore();
    if (!recovery && current.active === projectId && canSave(projectId)) {
      return;
    }
    snapshot();
    const saved = readStore().layouts[projectId];
    const base = recovery ?? saved ?? defaultLayoutFor(projectId, threads);
    // Preserve unknown panes until the index is available. The clicked row is
    // authoritative even if its thread has not appeared in the index yet.
    const cleaned = ready && !error
      ? sanitize(base, threadId ? new Set([...liveIds, threadId]) : liveIds)
      : base;
    const target = threadId
      ? selectThread(cleaned, projectId, threadId)
      : cleaned;
    if (useHostSplitLayout && host.isAvailable && host.setLayout(target)) {
      writeStore({ active: projectId, layouts: { ...readStore().layouts, [projectId]: target } });
      allowSaving(projectId);
      // Instant path: the host validated, normalized, applied, and routed.
      setStore(readStore());
      return;
    }
    try {
      hideBrowserPreviewsForReload(window);
    } catch (cause) {
      console.error("Workspace switch stopped before reload", cause);
      window.alert("Could not hide the browser preview. The workspace was not switched. Use bb’s View > Reload, then try again.");
      return;
    }
    writeStore({ active: projectId, layouts: { ...readStore().layouts, [projectId]: target } });
    writeHostLayout(target);
    prepareLayoutHandoff(projectId, target);
    window.history.replaceState(null, "", routeFor(target, projectId));
    window.location.reload();
  }, [ready, error, threads, liveIds, host.isAvailable, host.setLayout]);

  const forget = (projectId: string) => {
    const current = readStore();
    const { [projectId]: _dropped, ...rest } = current.layouts;
    const next = { active: current.active === projectId ? null : current.active, layouts: rest };
    writeStore(next);
    setStore(next);
  };

  const savingPaused = needsSavingChoice();
  const useCurrentLayout = () => {
    if (!store.active) return;
    allowSaving(store.active);
    snapshot();
  };
  return { projects, shortcutIds, store, counts, ready, error, switchTo, forget, savingPaused, useCurrentLayout };
}

function Switcher({ dismiss }: { dismiss(): void }) {
  const { projects, shortcutIds, store, counts, ready, error, switchTo, forget } = useWorkspaces();
  return (
    <div className="flex max-h-80 flex-col overflow-y-auto p-1">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      {error ? <div role="alert" className="px-2 py-3 text-sm">{error}</div> : !ready ? (
        <div className="px-2 py-3 text-sm text-muted-foreground">Loading…</div>
      ) : (
        projects.map((p) => {
          const index = shortcutIds.indexOf(p.id);
          const active = p.id === store.active;
          const saved = p.id in store.layouts;
          return (
            <div key={p.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => { switchTo(p.id); dismiss(); }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
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
              </button>
              {store.previous?.[p.id] ? (
                <button type="button" title="Restore previous layout" disabled={!ready || !!error}
                  aria-label={`Restore previous layout for ${p.name}`}
                  onClick={() => { switchTo(p.id, undefined, store.previous?.[p.id]); dismiss(); }}
                  className="size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                  ↶
                </button>
              ) : null}
              {saved && !active ? (
                <button
                  type="button"
                  title="Forget saved layout"
                  aria-label={`Forget saved layout for ${p.name}`}
                  onClick={() => forget(p.id)}
                  className="invisible size-6 flex-none rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:visible"
                >
                  <Icon name="Minimize2" className="mx-auto size-3.5" />
                </button>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function WorkspaceOverlay() {
  const { projects, shortcutIds, store, ready, error, switchTo, savingPaused, useCurrentLayout } = useWorkspaces();
  const [targets, setTargets] = useState<ProjectTarget[]>([]);
  const scope = usePortalScopeProps();
  const switchRef = useRef(switchTo);
  switchRef.current = switchTo;
  useEffect(() => watchThreadClicks(document,
    () => readStore().active ?? (() => { const layout = readHostLayout(); return layout ? projectOf(layout) : null; })(),
    (projectId, threadId) => switchRef.current(projectId, threadId),
  ), []);
  useEffect(() => watchProjectTargets(document, (next) => {
    setTargets(next);
    window.dispatchEvent(new Event("workspaces:sidebar-changed"));
  }), []);
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
      switchTo(shortcutIds[index]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutIds, ready, error, switchTo]);
  useEffect(() => {
    if (!ready || error) return;
    const dispose = targets
      .filter(({ projectId }) => projects.some((project) => project.id === projectId))
      .map(({ projectId, container }) => listenForProjectNameClick(container, () => switchTo(projectId)));
    return () => { for (const cleanup of dispose) cleanup(); };
  }, [targets, projects, ready, error, switchTo]);
  return <>
    {savingPaused ? <div {...scope} role="status" className="fixed bottom-4 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
      <span>{projects.find((p) => p.id === store.active)?.name ?? "Current workspace"}: saved panes protected — changes aren’t being saved yet</span>
      <button type="button" disabled={!ready || !!error} className="rounded px-2 py-1 hover:bg-accent disabled:opacity-50" onClick={() => store.active && switchTo(store.active)}>Restore saved panes</button>
      <button type="button" className="rounded px-2 py-1 hover:bg-accent" onClick={useCurrentLayout}>Keep current panes</button>
    </div> : null}
    {targets.map(({ projectId, container }) => {
    const index = shortcutIds.indexOf(projectId);
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    const label = `Switch to ${project.name} workspace${index >= 0 && index < 9 ? ` (${shortcutLabel(index)})` : ""}`;
    return createPortal(
      <span {...scope} className="inline-flex items-center">
        <button data-workspace-grid="" type="button" title={error ?? label} aria-label={label}
          aria-pressed={store.active === projectId} disabled={!ready || !!error}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); switchTo(projectId); }}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-40 max-md:pointer-coarse:size-9">
          <Icon name="GridView" className="size-4" />
        </button>
      </span>, container, projectId,
    );
    })}
  </>;
}

export default definePluginApp((app) => {
  // Keep the active project's saved layout current with whatever is on screen.
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
    id: "switch-workspace", title: "Workspaces: switch workspace",
    run: () => disclosure.open(),
  });
});
