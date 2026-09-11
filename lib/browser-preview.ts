interface BrowserVisibilityApi {
  setVisible(request: { tabId: string; visible: boolean }): void;
}

/** Hide this window's persisted native previews without closing any browser tab.
 * bb's fixed-panel state persists browser IDs (client-core/fixed-panel-tabs-state).
 * The desktop IPC scopes setVisible to the sending window and ignores absent IDs.
 */
export function hideBrowserPreviewsForReload(win: Window): void {
  const browser = (win as unknown as { bbDesktop?: { browser?: BrowserVisibilityApi } }).bbDesktop?.browser;
  if (!browser) return; // Web bb has no native views above the renderer.
  const ids = new Set<string>();
  const storage = win.localStorage;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith("bb.thread.fixedPanelTabsState-")) continue;
    let state: { version?: unknown; secondary?: { tabs?: unknown } };
    try {
      state = JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      console.warn(`Skipping unreadable saved browser tabs for ${key}`);
      continue;
    }
    if (!state || state.version !== 1 || !Array.isArray(state.secondary?.tabs)) {
      console.warn(`Skipping unsupported saved browser tabs for ${key}`);
      continue;
    }
    for (const tab of state.secondary.tabs) {
      if (tab?.kind !== "browser") continue;
      if (typeof tab.id !== "string" || !tab.id) {
        console.warn(`Skipping invalid browser tab in ${key}`);
        continue;
      }
      ids.add(tab.id);
    }
  }
  const failed: string[] = [];
  for (const tabId of ids) {
    try {
      browser.setVisible({ tabId, visible: false });
    } catch {
      failed.push(tabId);
    }
  }
  if (failed.length) throw new Error(`Could not hide browser previews: ${failed.join(", ")}`);
}
