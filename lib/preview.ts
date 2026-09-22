// Switch preview: while the pointer rests on a switch affordance, mark the
// sidebar rows that workspace would pull in with `data-workspace-preview`.
//   project heading → the whole project group (heading tier + every thread row);
//   thread workspace → that thread's row plus its descendants as currently
//   rendered (collapsed children are not rendered, so they are not marked).
// The anchor row additionally carries `data-workspace-preview-anchor` for its
// rail. Depth is read from the row's inline left padding, the same way bb's
// ThreadRow lays out nesting (8px base + 24px per level; Sidebar organizer
// measures rows identically).

import { PERSONAL_PROJECT_ID, personalSection, sectionOf } from "./sidebar.ts";

const ROW_LINK = "a[data-sidebar-thread-id]";
const PROJECT = "[data-sidebar-project-id]";
const HEADING = '[data-sidebar-sticky-tier="label"]';
export const PREVIEW_ATTR = "data-workspace-preview";
export const PREVIEW_ANCHOR_ATTR = "data-workspace-preview-anchor";
const ROW_BASE_PADDING_PX = 8;
const ROW_DEPTH_STEP_PX = 24;

export type PreviewTarget = { kind: "project"; projectId: string } | { kind: "thread"; threadId: string };

// 0.3.4: the built-in Threads section (proj_personal) is a group too; see sidebar.ts.
function rowsOf(group: Element, doc: Document): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLAnchorElement>(ROW_LINK))
    .filter((link) => sectionOf(link) === group)
    .map((link) => link.parentElement)
    .filter((row): row is HTMLElement => !!row && row.ownerDocument === doc);
}

function depthOf(row: HTMLElement, view: Window): number {
  const padding = parseFloat(row.style.paddingLeft) || parseFloat(view.getComputedStyle(row).paddingLeft) || ROW_BASE_PADDING_PX;
  return Math.max(0, Math.round((padding - ROW_BASE_PADDING_PX) / ROW_DEPTH_STEP_PX));
}

export function clearPreview(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${PREVIEW_ATTR}], [${PREVIEW_ANCHOR_ATTR}]`))) {
    el.removeAttribute(PREVIEW_ATTR);
    el.removeAttribute(PREVIEW_ANCHOR_ATTR);
  }
}

/** Mark the rows a switch to `target` would pull in. Returns the marked elements. */
export function markPreview(doc: Document, target: PreviewTarget): HTMLElement[] {
  clearPreview(doc);
  const view = doc.defaultView;
  if (!view) return [];
  const marked: HTMLElement[] = [];
  if (target.kind === "project") {
    const personal = target.projectId === PERSONAL_PROJECT_ID ? personalSection(doc) : null;
    const groups = [...Array.from(doc.querySelectorAll<HTMLElement>(PROJECT)), ...(personal ? [personal] : [])];
    for (const group of groups) {
      if (group !== personal && group.getAttribute("data-sidebar-project-id") !== target.projectId) continue;
      const heading = Array.from(group.querySelectorAll<HTMLElement>(HEADING)).find((h) => sectionOf(h) === group);
      if (heading) { heading.setAttribute(PREVIEW_ATTR, ""); heading.setAttribute(PREVIEW_ANCHOR_ATTR, ""); marked.push(heading); }
      for (const row of rowsOf(group, doc)) { row.setAttribute(PREVIEW_ATTR, ""); marked.push(row); }
    }
    return marked;
  }
  for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>(ROW_LINK))) {
    if (link.getAttribute("data-sidebar-thread-id") !== target.threadId) continue;
    const anchor = link.parentElement;
    const group = sectionOf(link);
    if (!anchor || !group) continue;
    const rows = rowsOf(group, doc);
    const start = rows.indexOf(anchor);
    if (start === -1) continue;
    const anchorDepth = depthOf(anchor, view);
    anchor.setAttribute(PREVIEW_ATTR, ""); anchor.setAttribute(PREVIEW_ANCHOR_ATTR, ""); marked.push(anchor);
    for (let i = start + 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (depthOf(row, view) <= anchorDepth) break;
      row.setAttribute(PREVIEW_ATTR, ""); marked.push(row);
    }
  }
  return marked;
}
