// 0.3.2 member-click switching. A thread is a member of thread workspace W
// when it is W's anchor or a descendant of it at any depth (index
// `parentThreadId` chain). Nested workspaces: the DEEPEST one containing the
// clicked thread wins. Pure; the click handler supplies the inputs.

import { threadKey, type WorkspaceKey } from "./layout.ts";

export interface ParentLink {
  id: string;
  parentThreadId: string | null;
}

/** The anchor id of the deepest thread workspace containing `threadId`, or null. */
export function deepestWorkspaceFor(threadId: string, workspaceAnchors: ReadonlySet<string>, threads: readonly ParentLink[]): string | null {
  const parents = new Map(threads.map((t) => [t.id, t.parentThreadId]));
  const seen = new Set<string>();
  let current: string | null = threadId;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (workspaceAnchors.has(current)) return current;
    current = parents.get(current) ?? null;
  }
  return null;
}

export interface MemberClickInput {
  threadId: string;
  projectId: string;
  /** Project on screen; a different project is the cross-project path, not this one. */
  activeProjectId: string | null;
  /** Key on screen for the active project. */
  activeKey: WorkspaceKey | null;
  workspaceAnchors: ReadonlySet<string>;
  threads: readonly ParentLink[];
  /** The `memberClickSwitches` setting. */
  enabled: boolean;
}

/** The workspace key a plain same-project click should switch to, or null for default behavior. */
export function resolveMemberClick(input: MemberClickInput): WorkspaceKey | null {
  if (!input.enabled) return null;
  if (input.activeProjectId !== input.projectId) return null;
  const anchor = deepestWorkspaceFor(input.threadId, input.workspaceAnchors, input.threads);
  if (!anchor) return null;
  const key = threadKey(anchor);
  return key === input.activeKey ? null : key;
}
