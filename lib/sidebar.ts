const PROJECT = "[data-sidebar-project-id]";
const CONTROLS = "[data-sidebar-trailing-controls]";
const HEADING = '[data-sidebar-sticky-tier="label"]';
// 0.3.4: bb's built-in "Threads" section (the personal project, proj_personal)
// is rendered by BuiltInSidebarSection -> TopLevelSidebarSection with no
// [data-sidebar-project-id] wrapper and no data-sidebar-section-id (the
// sortable wrapper consumes the id; TopLevelSidebarSection.tsx:164 renders it
// undefined). The only stable identity is structural: the SidebarStickyGroup
// sits directly under the section order list, and its label carries the
// section name in `title` (ProjectList.tsx:1570 "Pinned", :1576 "Threads").
// Same direct-child path Compact UI 0.7.4 uses.
const BUILT_IN_GROUP = '[data-sidebar-sticky-stack] > [data-sidebar="group-content"] > div > [data-sidebar-sticky-group]';
export const PERSONAL_PROJECT_ID = "proj_personal";
export const PERSONAL_SECTION_LABEL = "Threads";
const THREAD_LINK = "a[data-sidebar-thread-id]";

/** Project id a sidebar thread link points at, from its href (personal threads use /threads/<id>). */
export function linkProjectId(link: HTMLAnchorElement): string | null {
  try {
    const url = new URL(link.getAttribute("href") ?? "", link.ownerDocument.baseURI);
    const project = /^\/projects\/([^/]+)\/threads\/([^/]+)\/?$/.exec(url.pathname);
    if (project && project[2] === link.dataset.sidebarThreadId) return decodeURIComponent(project[1]!);
    const personal = /^\/threads\/([^/]+)\/?$/.exec(url.pathname);
    if (personal && personal[1] === link.dataset.sidebarThreadId) return PERSONAL_PROJECT_ID;
  } catch { /* fall through */ }
  return null;
}

/**
 * The built-in personal "Threads" section group, or null. Pinned (and any
 * other built-in section) is excluded by label. A Threads section whose rows
 * link into other projects (machine sidebar mode) is not the personal
 * project, so it is not matched either.
 */
export function personalSection(doc: Document): HTMLElement | null {
  for (const group of Array.from(doc.querySelectorAll<HTMLElement>(BUILT_IN_GROUP))) {
    if (group.closest(PROJECT) || group.hasAttribute("data-sidebar-section-id")) continue;
    const heading = Array.from(group.children).find((child) => child.matches(HEADING));
    const title = heading?.querySelector<HTMLElement>(":scope > span > span[title]");
    if (!heading || !title || title.getAttribute("title") !== PERSONAL_SECTION_LABEL) continue;
    const foreign = Array.from(group.querySelectorAll<HTMLAnchorElement>(THREAD_LINK))
      .some((link) => link.closest(PROJECT) === null && linkProjectId(link) !== PERSONAL_PROJECT_ID);
    if (foreign) continue;
    return group;
  }
  return null;
}

/** The sidebar group an element belongs to: its project item, else the personal section. */
export function sectionOf(el: Element): HTMLElement | null {
  const project = el.closest<HTMLElement>(PROJECT);
  if (project) return project;
  const group = el.closest<HTMLElement>("[data-sidebar-sticky-group]");
  return group && personalSection(el.ownerDocument) === group ? group : null;
}

/** Project id of a sidebar group element (project item or the personal section). */
export function sectionProjectId(group: HTMLElement): string | null {
  return group.dataset.sidebarProjectId ?? (group.matches(PROJECT) ? null : PERSONAL_PROJECT_ID);
}

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
  const row = sectionOf(container);
  const heading = container.closest(HEADING);
  if (!row || !heading) return () => {};
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const name = target?.closest(`${HEADING} > span > span[title]`);
    if (!name || sectionOf(name) !== row || name.closest(HEADING) !== heading) return;
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
    // Project items first, then the personal section (0.3.4), whose heading
    // controls live directly under its sticky group.
    const personal = personalSection(doc);
    const rows = [...Array.from(doc.querySelectorAll<HTMLElement>(PROJECT)), ...(personal ? [personal] : [])];
    for (const row of rows) {
      const projectId = sectionProjectId(row);
      const actions = row === personal
        ? Array.from(row.children).find((child) => child.matches(HEADING))?.querySelector<HTMLElement>(`:scope > ${CONTROLS}`) ?? null
        : row.querySelector<HTMLElement>(CONTROLS);
      if (!projectId || !actions || sectionOf(actions) !== row) continue;
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
      if (parent?.closest(CONTROLS) || parent?.matches(PROJECT) || parent?.matches("[data-sidebar-sticky-group]")) return true;
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
