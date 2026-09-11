const PROJECT = "[data-sidebar-project-id]";
const CONTROLS = "[data-sidebar-trailing-controls]";

export function sidebarProjectIds(doc: Document): string[] {
  return [...new Set(Array.from(doc.querySelectorAll<HTMLElement>(PROJECT))
    .filter((row) => row.querySelector(CONTROLS)?.closest(PROJECT) === row)
    .map((row) => row.dataset.sidebarProjectId!)
    .filter(Boolean))];
}

export interface ProjectTarget {
  projectId: string;
  container: HTMLSpanElement;
}

/** Listen below React's root so its drag-click suppression runs first. */
export function listenForProjectNameClick(container: HTMLElement, activate: () => void): () => void {
  const row = container.closest<HTMLElement>(PROJECT);
  const heading = container.closest('[data-sidebar-sticky-tier="label"]');
  if (!row || !heading) return () => {};
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const name = target?.closest('[data-sidebar-sticky-tier="label"] > span > span[title]');
    if (!name || name.closest(PROJECT) !== row || name.closest('[data-sidebar-sticky-tier="label"]') !== heading) return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  };
  row.addEventListener("click", onClick);
  return () => row.removeEventListener("click", onClick);
}

/** Own only our empty portal mount; never alter a host React child. */
export function watchProjectTargets(doc: Document, changed: (targets: ProjectTarget[]) => void): () => void {
  let targets: ProjectTarget[] = [];
  let frame: number | null = null;
  const win = doc.defaultView!;
  const reconcile = () => {
    frame = null;
    const next: ProjectTarget[] = [];
    for (const row of Array.from(doc.querySelectorAll<HTMLElement>(PROJECT))) {
      const projectId = row.dataset.sidebarProjectId;
      const actions = row.querySelector<HTMLElement>(CONTROLS);
      if (!projectId || !actions || actions.closest(PROJECT) !== row) continue;
      const existing = targets.find((t) => t.projectId === projectId && t.container.parentElement === actions);
      const container = existing?.container ?? doc.createElement("span");
      if (!existing) {
        container.dataset.workspaceMount = "";
        container.style.display = "inline-flex";

      }
      // Keep one consistent rightmost slot, including after host reconciliation.
      if (actions.lastElementChild !== container) actions.append(container);
      next.push({ projectId, container });
    }
    for (const target of targets) {
      if (!next.some((t) => t.container === target.container)) target.container.remove();
    }
    if (next.length !== targets.length || next.some((t, i) => targets[i]?.container !== t.container)) {
      targets = next;
      changed(next);
    }
  };
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      const parent = record.target instanceof Element ? record.target : null;
      if (parent?.closest("[data-workspace-mount]")) return false;
      if (parent?.closest(CONTROLS) || parent?.matches(PROJECT)) return true;
      return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        node instanceof Element && (node.matches(`${PROJECT}, ${CONTROLS}`) || node.querySelector(`${PROJECT}, ${CONTROLS}`)));
    });
    if (relevant && frame === null) frame = win.requestAnimationFrame(reconcile);
  });
  reconcile();
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (frame !== null) win.cancelAnimationFrame(frame);
    for (const target of targets) target.container.remove();
  };
}

function isMac(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function shortcutLabel(index: number): string {
  return `${isMac() ? "⌘⌥" : "Ctrl+Alt+"}${index + 1}`;
}

export function shortcutIndex(event: KeyboardEvent): number | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || !event.altKey) return null;
  if (isMac() ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey || event.getModifierState("AltGraph"))) return null;
  if (event.composedPath().some((node) => node instanceof Element &&
    node.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm, .monaco-editor'))) return null;
  if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-state="closed"]):not([inert]), dialog[open]:not([inert])')) return null;
  // Alt modifies event.key on macOS; physical Digit codes keep the chord usable.
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) - 1 : null;
}
