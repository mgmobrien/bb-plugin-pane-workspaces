const THREAD = "a[data-sidebar-thread-id]";
// Mirrors bb ThreadRow.tsx SIDEBAR_TITLE_DOUBLE_CLICK_MS (module-private).
const DOUBLE_CLICK_MS = 400;

/** Suppress Router navigation, while retaining bb's own click/rename handler. */
export function watchThreadClicks(
  doc: Document,
  activeProject: () => string | null,
  activate: (projectId: string, threadId: string) => void,
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
    const match = /^\/projects\/([^/]+)\/threads\/([^/]+)\/?$/.exec(url.pathname);
    if (url.origin !== new URL(doc.baseURI).origin || !match || match[2] !== link.dataset.sidebarThreadId) return;
    const [, projectId, threadId] = match;
    const now = Date.now();
    const doubleClick = last?.threadId === threadId && now - last.at < DOUBLE_CLICK_MS;
    last = { at: now, threadId };
    if (doubleClick || projectId === activeProject()) return;
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
