// Thread-row workspace control. Plain DOM (no React): one small grid button
// per sidebar thread row, mounted at the end of the row's title span
// (`a[data-sidebar-thread-id] + span`), immediately left of bb's status /
// hover-action slot. That slot is overlaid by bb's own archive and menu
// buttons on hover, so the control cannot live inside it.
//
// Row states, written on the row container (the link's parent) so CSS can key
// on them without touching bb's own attributes:
//   data-workspace-thread="candidate"  no workspace; icon shows on row hover
//   data-workspace-thread="workspace"  has a workspace; icon persistent
//   data-workspace-active-thread=""    its workspace is the one on screen
//
// Event isolation: the mount stops mousedown/pointerdown/click/keydown at the
// DOM level so bb's row handlers and Router never see them. Sidebar organizer
// listens at document capture (which runs before any of this) but skips
// targets inside a `button` (its NOT_A_HANDLE list), so the control must
// remain a real <button>. bb's split drag arms on pointerdown crossing the
// sidebar edge; stopping pointerdown here keeps a click on the icon from
// arming it.

import { GridViewIcon } from "@hugeicons/core-free-icons";
import { linkProjectId } from "./sidebar.ts";

const ROW_LINK = "a[data-sidebar-thread-id]";
const PROJECT = "[data-sidebar-project-id]";
const RENAME_INPUT = 'input[aria-label="Thread name"]';
export const MOUNT_ATTR = "data-workspace-thread-mount";
export const BUTTON_ATTR = "data-workspace-thread-button";
export const STATE_ATTR = "data-workspace-thread";
export const ACTIVE_ATTR = "data-workspace-active-thread";

export type RowState = "candidate" | "workspace" | "active";
export type RowAction = "create" | "switch" | "forget";

export interface ThreadRowTarget {
  threadId: string;
  projectId: string;
  link: HTMLAnchorElement;
  row: HTMLElement;
  mount: HTMLSpanElement;
  button: HTMLButtonElement;
}

export interface ThreadRowHandlers {
  /** Current state for a thread (called on every reconcile). */
  stateOf(threadId: string): RowState;
  /** The user clicked the icon. `forget` is Shift-click on a workspace row. */
  activate(target: ThreadRowTarget, action: RowAction): void;
  /** Pointer rests on / leaves a workspace row (anywhere on the row) or its icon. */
  preview?(target: ThreadRowTarget | null): void;
}

export const TOOLTIP: Record<RowState, string> = {
  candidate: "Make this thread a workspace",
  workspace: "Switch to this workspace (Shift-click to forget)",
  active: "This workspace is on screen (Shift-click to forget)",
};

/** Project id from the row link's href; personal threads use /threads/<id>. */
export function projectIdOf(link: HTMLAnchorElement): string | null {
  return linkProjectId(link) ?? link.closest<HTMLElement>(PROJECT)?.dataset.sidebarProjectId ?? null;
}

/** Build the grid glyph from the same icon data the heading button renders. */
export function gridIcon(doc: Document, className: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("xmlns", NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  for (const [tag, attrs] of GridViewIcon as ReadonlyArray<readonly [string, Record<string, string>]>) {
    const el = doc.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "key") continue;
      el.setAttribute(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(value));
    }
    svg.append(el);
  }
  return svg;
}

const BUTTON_CLASS = "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring";

export function applyState(target: Pick<ThreadRowTarget, "row" | "button">, state: RowState): void {
  target.row.setAttribute(STATE_ATTR, state === "candidate" ? "candidate" : "workspace");
  if (state === "active") target.row.setAttribute(ACTIVE_ATTR, ""); else target.row.removeAttribute(ACTIVE_ATTR);
  target.button.setAttribute("data-state", state);
  target.button.setAttribute("title", TOOLTIP[state]);
  target.button.setAttribute("aria-label", TOOLTIP[state]);
  target.button.setAttribute("aria-pressed", state === "active" ? "true" : "false");
}

/** Own only our mount; never alter a host React child other than the row's data attributes. */
export function watchThreadRows(doc: Document, handlers: ThreadRowHandlers): { dispose(): void; refresh(): void } {
  const targets = new Map<HTMLAnchorElement, ThreadRowTarget>();
  const win = doc.defaultView!;
  let frame: number | null = null;

  const stop = (event: Event) => { event.stopPropagation(); };
  const stopAndPrevent = (event: Event) => { event.stopPropagation(); event.preventDefault(); };

  const create = (link: HTMLAnchorElement): ThreadRowTarget | null => {
    const threadId = link.dataset.sidebarThreadId;
    const row = link.parentElement;
    const title = link.nextElementSibling;
    if (!threadId || !row || !(title instanceof HTMLElement) || title.tagName !== "SPAN") return null;
    const projectId = projectIdOf(link);
    if (!projectId) return null;
    const mount = doc.createElement("span");
    mount.setAttribute(MOUNT_ATTR, "");
    mount.className = "relative z-10 inline-flex shrink-0 items-center";
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute(BUTTON_ATTR, "");
    button.className = BUTTON_CLASS;
    button.append(gridIcon(doc, "size-3.5"));
    mount.append(button);
    const target: ThreadRowTarget = { threadId, projectId, link, row, mount, button };
    mount.addEventListener("pointerdown", stop);
    mount.addEventListener("mousedown", stop);
    mount.addEventListener("keydown", stop);
    mount.addEventListener("dblclick", stopAndPrevent);
    mount.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (event.button !== 0 || row.querySelector(RENAME_INPUT)) return;
      const state = handlers.stateOf(threadId);
      if (state === "candidate") handlers.activate(target, "create");
      else if (event.shiftKey) handlers.activate(target, "forget");
      else handlers.activate(target, "switch");
    });
    // 0.3.2: the whole anchor row previews its membership (attributes + CSS
    // only; no element is added, so Sidebar organizer's drag is unaffected).
    // pointerenter/leave do not bubble, so the row listener also covers the icon.
    row.addEventListener("pointerenter", () => {
      if (handlers.stateOf(threadId) !== "candidate") handlers.preview?.(target);
    });
    row.addEventListener("pointerleave", () => handlers.preview?.(null));
    title.append(mount);
    return target;
  };

  const reconcile = () => {
    frame = null;
    for (const [link, target] of targets) {
      if (!link.isConnected || !link.matches(ROW_LINK) || link.parentElement !== target.row || link.dataset.sidebarThreadId !== target.threadId) {
        target.mount.remove();
        target.row.removeAttribute(STATE_ATTR);
        target.row.removeAttribute(ACTIVE_ATTR);
        targets.delete(link);
      }
    }
    for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>(ROW_LINK))) {
      let target = targets.get(link);
      if (!target) {
        const created = create(link);
        if (!created) continue;
        target = created;
        targets.set(link, target);
      } else if (!target.mount.isConnected) {
        // Host reconciliation replaced the title span's children; re-attach.
        const title = link.nextElementSibling;
        if (title instanceof HTMLElement && title.tagName === "SPAN") title.append(target.mount);
      }
      target.projectId = projectIdOf(link) ?? target.projectId;
      applyState(target, handlers.stateOf(target.threadId));
    }
  };

  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      const parent = record.target instanceof Element ? record.target : null;
      if (parent?.closest(`[${MOUNT_ATTR}]`)) return false;
      if (record.type === "attributes") return true;
      return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        node instanceof Element && !node.matches(`[${MOUNT_ATTR}]`) && (node.matches(ROW_LINK) || !!node.querySelector(ROW_LINK)));
    });
    if (relevant && frame === null) frame = win.requestAnimationFrame(reconcile);
  });
  reconcile();
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-sidebar-thread-id", "href"] });
  return {
    refresh: reconcile,
    dispose() {
      observer.disconnect();
      if (frame !== null) win.cancelAnimationFrame(frame);
      for (const target of targets.values()) {
        target.mount.remove();
        target.row.removeAttribute(STATE_ATTR);
        target.row.removeAttribute(ACTIVE_ATTR);
      }
      targets.clear();
    },
  };
}
