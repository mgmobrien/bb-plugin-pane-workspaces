// Pure helpers for the workspace picker: breadcrumbs, most-recently-used
// ordering within a project, and text filtering.

export interface PickerThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  title: string;
}

export interface PickerRecord {
  threadId: string;
  projectId: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface PickerEntry {
  key: string;
  kind: "project" | "thread";
  projectId: string;
  threadId?: string;
  /** Project name, then ancestor titles, then the thread's own title. */
  breadcrumb: string[];
}

/** Project name › ancestor titles › own title. Falls back to the record's stored title. */
export function breadcrumbFor(
  record: Pick<PickerRecord, "threadId" | "projectId" | "title">,
  threads: readonly PickerThread[],
  projectName: string,
): string[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(record.threadId);
  if (!current) return [projectName, record.title || record.threadId];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current.title || current.id);
    current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
  }
  return [projectName, ...chain];
}

/** Most recently used first, then newest; ties by thread id for stability. */
export function orderByMostRecentlyUsed<T extends Pick<PickerRecord, "threadId" | "lastUsedAt" | "createdAt">>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt || a.threadId.localeCompare(b.threadId));
}

/** Case-insensitive match of every whitespace-separated term against the breadcrumb. */
export function matchesQuery(entry: Pick<PickerEntry, "breadcrumb">, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = entry.breadcrumb.join(" › ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
