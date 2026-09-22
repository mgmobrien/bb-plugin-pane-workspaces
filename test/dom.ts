// Shared jsdom bootstrap for store/DOM unit tests (node --test).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

export function installDom(html = "<body></body>"): { window: Window & typeof globalThis; reset(): void } {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  const win = dom.window as Window & typeof globalThis;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "Element", "HTMLElement", "HTMLAnchorElement", "MutationObserver", "Event", "Node", "SVGSVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    g[key] = (win as unknown as Record<string, unknown>)[key];
  }
  return {
    window: win,
    reset() {
      win.localStorage.clear();
      win.sessionStorage.clear();
      const w = win as unknown as Record<string, unknown>;
      delete w.__bbWorkspacesSaving;
      delete w.__bbWorkspacesSession;
      delete w.__bbWorkspacesSessionWarned;
      delete w.__bbWorkspacesTransition;
      win.document.body.innerHTML = "";
    },
  };
}

export const pane = (id: string, projectId: string, threadId: string) =>
  ({ type: "pane" as const, paneId: id, content: { kind: "thread" as const, projectId, threadId } });
export const single = (projectId: string, threadId: string, paneId = "p1") => ({ root: pane(paneId, projectId, threadId), focusedPaneId: paneId });
