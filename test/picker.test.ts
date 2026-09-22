import { test } from "node:test";
import assert from "node:assert/strict";
import { breadcrumbFor, matchesQuery, orderByMostRecentlyUsed } from "../lib/picker.ts";

const threads = [
  { id: "root", projectId: "pa", parentThreadId: null, title: "Root" },
  { id: "mid", projectId: "pa", parentThreadId: "root", title: "Middle" },
  { id: "leaf", projectId: "pa", parentThreadId: "mid", title: "Leaf" },
  { id: "loopA", projectId: "pa", parentThreadId: "loopB", title: "A" },
  { id: "loopB", projectId: "pa", parentThreadId: "loopA", title: "B" },
];

test("breadcrumb: project name, ancestors in order, then the thread; unknown thread falls back to the record title", () => {
  assert.deepEqual(breadcrumbFor({ threadId: "leaf", projectId: "pa", title: "stale" }, threads, "Alpha"), ["Alpha", "Root", "Middle", "Leaf"]);
  assert.deepEqual(breadcrumbFor({ threadId: "root", projectId: "pa", title: "Root" }, threads, "Alpha"), ["Alpha", "Root"]);
  assert.deepEqual(breadcrumbFor({ threadId: "missing", projectId: "pa", title: "Archived one" }, threads, "Alpha"), ["Alpha", "Archived one"]);
  assert.deepEqual(breadcrumbFor({ threadId: "loopA", projectId: "pa", title: "A" }, threads, "Alpha"), ["Alpha", "B", "A"], "a parent cycle terminates");
});

test("MRU ordering: most recently used first, newest breaks ties, id keeps it stable", () => {
  const ordered = orderByMostRecentlyUsed([
    { threadId: "b", lastUsedAt: 10, createdAt: 1 },
    { threadId: "a", lastUsedAt: 30, createdAt: 2 },
    { threadId: "d", lastUsedAt: 10, createdAt: 5 },
    { threadId: "c", lastUsedAt: 10, createdAt: 5 },
  ]);
  assert.deepEqual(ordered.map((r) => r.threadId), ["a", "c", "d", "b"]);
});

test("search: every term must match somewhere in the breadcrumb, case-insensitive", () => {
  const entry = { breadcrumb: ["Alpha", "Root", "Leaf"] };
  assert.equal(matchesQuery(entry, ""), true);
  assert.equal(matchesQuery(entry, "leaf alpha"), true);
  assert.equal(matchesQuery(entry, "LEAF"), true);
  assert.equal(matchesQuery(entry, "beta"), false);
});
