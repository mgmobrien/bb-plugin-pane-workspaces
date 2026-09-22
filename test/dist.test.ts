import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/app.js", import.meta.url));

test("dist/app.js registers the Workspaces nav panel with the expected id, title and icon", () => {
  const js = readFileSync(dist, "utf8");
  const match = /navPanel\(\{[^}]*\}\)/.exec(js);
  assert.ok(match, "navPanel registration present in the bundle");
  const registration = match[0];
  assert.match(registration, /id:\s*["']workspaces["']/);
  assert.match(registration, /title:\s*["']Workspaces["']/);
  assert.match(registration, /icon:\s*["']GridView["']/);
  assert.match(registration, /path:\s*["']workspaces["']/);
  // The bundler escapes non-ASCII (… → …); accept either spelling.
  const has = (title: string) => js.includes(title) || js.includes(title.replace("…", "\\u2026"));
  for (const title of ["Workspaces: switch to workspace…", "Workspaces: make current thread a workspace", "Workspaces: reset this workspace to its group", "Workspaces: forget current thread's workspace", "Clicking a thread in a workspace switches to it"]) {
    assert.ok(has(title), `palette action ${title}`);
  }
});
