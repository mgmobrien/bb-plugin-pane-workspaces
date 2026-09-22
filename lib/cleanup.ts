// Thread workspace upkeep against the server index. Pure: the caller applies
// the returned changes through the store's per-key writes.
//
// - Metadata refresh: `projectId`, `parentThreadId` and `title` are display
//   data. A moved thread updates `projectId`; a re-parented thread updates
//   `parentThreadId`. Neither changes the record's identity (`thread:<id>`).
// - Removal: a thread missing from the index is NOT dropped on sight. The index
//   is capped (400 threads) and can be transiently stale, so a record is only a
//   removal candidate after two consecutive index refreshes without it, and it
//   is dropped only when the server confirms the thread is gone
//   (`threads.get` not found, or archived).

export interface IndexedThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  title: string;
}

export interface KnownThreadWorkspace {
  threadId: string;
  projectId: string;
  parentThreadId: string | null;
  title: string;
}

export interface MetaChange {
  threadId: string;
  /** Only the fields that differ from the record. */
  patch: { projectId?: string; parentThreadId?: string | null; title?: string };
  projectChanged: boolean;
  parentChanged: boolean;
  fromProjectId: string;
}

export interface ReconcileResult {
  changes: MetaChange[];
  /** Thread ids absent from this refresh (miss count after this refresh). */
  misses: Map<string, number>;
  /** Thread ids absent from `requiredMisses` consecutive refreshes: ask the server before dropping. */
  candidates: string[];
}

export const REQUIRED_MISSES = 2;

export function reconcileThreadWorkspaces(
  records: readonly KnownThreadWorkspace[],
  index: readonly IndexedThread[],
  previousMisses: ReadonlyMap<string, number>,
  requiredMisses = REQUIRED_MISSES,
): ReconcileResult {
  const byId = new Map(index.map((t) => [t.id, t]));
  const changes: MetaChange[] = [];
  const misses = new Map<string, number>();
  const candidates: string[] = [];
  for (const record of records) {
    const live = byId.get(record.threadId);
    if (!live) {
      const count = (previousMisses.get(record.threadId) ?? 0) + 1;
      misses.set(record.threadId, count);
      if (count >= requiredMisses) candidates.push(record.threadId);
      continue;
    }
    const patch: MetaChange["patch"] = {};
    const projectChanged = live.projectId !== record.projectId;
    const parentChanged = live.parentThreadId !== record.parentThreadId;
    if (projectChanged) patch.projectId = live.projectId;
    if (parentChanged) patch.parentThreadId = live.parentThreadId;
    if (live.title !== record.title) patch.title = live.title;
    if (Object.keys(patch).length > 0) {
      changes.push({ threadId: record.threadId, patch, projectChanged, parentChanged, fromProjectId: record.projectId });
    }
  }
  return { changes, misses, candidates };
}
