import { linkProjectId } from "./sidebar.ts";

const THREAD = "a[data-sidebar-thread-id]";
// Mirrors bb ThreadRow.tsx SIDEBAR_TITLE_DOUBLE_CLICK_MS (module-private).
const DOUBLE_CLICK_MS = 400;

/**
 * Suppress Router navigation, while retaining bb's own click/rename handler.
 * Two intercepts, both plain left-click only (Cmd/Ctrl/Alt/Shift and other
 * buttons are never touched):
 *  - cross-project: the row's project differs from the active one → switch to
 *    that project's remembered workspace with the thread selected (0.2.x);
 *  - member click (0.3.2): same project, and `memberTarget` names a thread
 *    workspace the clicked thread belongs to that is not on screen → switch to
 *    it with the thread selected. When it returns null the click is bb's.
 * 0.3.4: personal threads (`/threads/<id>`, bb's built-in Threads section)
 * take the same two paths as project `proj_personal`; before 0.3.4 they were
 * unmatched and always fell through to bb's navigation.
 */
export function watchThreadClicks(
  doc: Document,
  activeProject: () => string | null,
  activate: (projectId: string, threadId: string, key?: string) => void,
  memberTarget: (projectId: string, threadId: string) => string | null = () => null,
): () => void {
  const links = new Set<HTMLAnchorElement>();
  const win = doc.defaultView!;
  let frame: number | null = null;
  let last: { at: number; threadId: string } | null = null;
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const link = event.currentTarget as HTMLAnchorElement;
    if (link.parentElement?.querySelector('input[aria-label="Thread name"]')) return;
    const url = new URL(link.href, doc.baseURI);
    if (url.origin !== new URL(doc.baseURI).origin) return;
    const projectId = linkProjectId(link);
    const threadId = link.dataset.sidebarThreadId;
    if (!projectId || !threadId) return;
    const now = Date.now();
    const doubleClick = last?.threadId === threadId && now - last.at < DOUBLE_CLICK_MS;
    last = { at: now, threadId };
    if (doubleClick) return;
    if (projectId === activeProject()) {
      const key = memberTarget(projectId, threadId);
      if (!key) return;
      event.preventDefault();
      activate(projectId, threadId, key);
      return;
    }
    // React Router calls bb's onClick even when defaultPrevented, then skips
    // navigation. Do not stop propagation: bb must prime/consume rename clicks.
    event.preventDefault();
    activate(projectId, threadId);
  };
  const reconcile = () => {
    frame = null;
    for (const link of links) {
      if (!link.isConnected || !link.matches(THREAD)) {
        link.removeEventListener("click", onClick);
        links.delete(link);
      }
    }
    for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>(THREAD))) {
      if (links.has(link)) continue;
      links.add(link);
      link.addEventListener("click", onClick);
    }
  };
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => record.type === "attributes" ||
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        node instanceof Element && (node.matches(THREAD) || node.querySelector(THREAD))));
    if (relevant && frame === null) frame = win.requestAnimationFrame(reconcile);
  });
  reconcile();
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sidebar-thread-id"] });
  return () => {
    observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const link of links) link.removeEventListener("click", onClick);
    links.clear();
  };
}
