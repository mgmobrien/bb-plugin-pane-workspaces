// 0.3.2 — a thread workspace IS its nesting group: the anchor thread and its
// DIRECT children (grandchildren belong to the child's own workspace). The
// layout is derived from the server index, never from whatever panes are open:
//   0 children → single pane
//   1 child    → row split 50/50 (anchor left, child right)
//   2+ children→ anchor as a full-height left column (45%); the children
//                stacked in a vertical split on the right (55%, equal heights)
//   more than MAX_CHILDREN children → the first MAX_CHILDREN in sidebar order;
//                the rest are reported so the caller can note the omission.
// Sidebar order mirrors bb's default sibling comparator
// (packages/client-core/src/sidebar/projectThreadGroups.ts compareStandardThreads):
// active threads first, ordered by createdAt descending; then the rest by
// latestAttentionAt descending, falling back to createdAt descending, then id.
// So the stack reads top-to-bottom like the sidebar. The focused pane is the
// anchor's.

import { newPaneId, type HostLayout, type LayoutNode } from "./layout.ts";

export interface GroupThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  createdAt: number;
  status?: string;
  latestAttentionAt?: number;
}

export const MAX_CHILDREN = 6;
export const ANCHOR_COLUMN = 0.45;

function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function byCreatedAtDesc(a: GroupThread, b: GroupThread): number {
  return b.createdAt - a.createdAt || compareCodepoint(a.id, b.id);
}
/** bb's default sidebar sibling order (its "updated" sort). */
export function compareSidebarSiblings(a: GroupThread, b: GroupThread): number {
  const aActive = a.status === "active", bActive = b.status === "active";
  if (aActive !== bActive) return aActive ? -1 : 1;
  if (aActive) return byCreatedAtDesc(a, b);
  return (b.latestAttentionAt ?? b.createdAt) - (a.latestAttentionAt ?? a.createdAt) || byCreatedAtDesc(a, b);
}

/** Direct children of `threadId` in sidebar order. */
export function childrenOf(threadId: string, threads: readonly GroupThread[]): GroupThread[] {
  return threads.filter((t) => t.parentThreadId === threadId && t.id !== threadId).sort(compareSidebarSiblings);
}

/** Anchor first, then direct children in sidebar order. Empty when the anchor is not indexed. */
export function groupOf(threadId: string, threads: readonly GroupThread[]): GroupThread[] {
  const anchor = threads.find((t) => t.id === threadId);
  return anchor ? [anchor, ...childrenOf(threadId, threads)] : [];
}

export interface DerivedGroupLayout {
  layout: HostLayout;
  /** Thread ids placed, anchor first then children top-to-bottom. */
  placed: string[];
  /** Children that did not fit (beyond MAX_CHILDREN). */
  omitted: string[];
}

/** Derive the group layout for `threadId`. Returns null when the thread is not in the index. */
export function deriveGroupLayout(threadId: string, threads: readonly GroupThread[]): DerivedGroupLayout | null {
  const group = groupOf(threadId, threads);
  if (group.length === 0) return null;
  const [anchor, ...children] = group;
  const chosen = children.slice(0, MAX_CHILDREN);
  const omitted = children.slice(MAX_CHILDREN).map((t) => t.id);
  const paneFor = (t: GroupThread): Extract<LayoutNode, { type: "pane" }> =>
    ({ type: "pane", paneId: newPaneId(), content: { kind: "thread", projectId: t.projectId, threadId: t.id } });
  const anchorPane = paneFor(anchor!);
  const childPanes = chosen.map(paneFor);
  let root: LayoutNode;
  if (childPanes.length === 0) root = anchorPane;
  else if (childPanes.length === 1) root = { type: "split", dir: "row", sizes: [0.5, 0.5], children: [anchorPane, childPanes[0]!] };
  else root = {
    type: "split", dir: "row", sizes: [ANCHOR_COLUMN, 1 - ANCHOR_COLUMN], children: [
      anchorPane,
      { type: "split", dir: "col", sizes: childPanes.map(() => 1 / childPanes.length), children: childPanes },
    ],
  };
  return { layout: { root, focusedPaneId: anchorPane.paneId }, placed: [anchor!.id, ...chosen.map((t) => t.id)], omitted };
}

/** Thread ids referenced by a layout's panes. */
export function threadIdsIn(layout: HostLayout): Set<string> {
  const ids = new Set<string>();
  const walk = (node: LayoutNode) => {
    if (node.type === "split") { node.children.forEach(walk); return; }
    if (node.content.kind === "thread") ids.add(node.content.threadId);
  };
  walk(layout.root);
  return ids;
}

/**
 * Clobber guard: while a thread workspace is active, a snapshot whose panes
 * contain none of the group's threads (anchor or direct children) must not be
 * saved to that key. Mixed arrangements with at least one group thread are
 * allowed. With no index yet, the group is the anchor alone.
 */
export function snapshotBelongsToGroup(anchorThreadId: string, layout: HostLayout, threads: readonly GroupThread[]): boolean {
  const group = new Set(groupOf(anchorThreadId, threads).map((t) => t.id));
  group.add(anchorThreadId);
  for (const id of threadIdsIn(layout)) if (group.has(id)) return true;
  return false;
}
