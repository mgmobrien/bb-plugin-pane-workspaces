import { readHostLayout, readStore, panesOf, routeMatchesLayout, currentKey, type HostLayout, type WorkspaceKey } from "./layout";

// 0.3.0: acceptance is keyed by the ACTIVE workspace key (`project:` or
// `thread:`), not the project id. The semantics are unchanged from 0.2.x.
const HANDOFF = "workspaces.pending-layout.v2";
const EVENT = "workspaces:saving-changed";
type SavingState = { key: WorkspaceKey | null; documentId?: string; choiceRequired?: boolean };
type SavingWindow = Window & { __bbWorkspacesSaving?: SavingState };
function state(): SavingState {
  const win = window as SavingWindow;
  const value = win.__bbWorkspacesSaving ??= { key: null };
  value.documentId ??= window.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return value;
}
export function canSave(key: WorkspaceKey): boolean { return state().key === key; }
export function needsSavingChoice(): boolean { return state().choiceRequired === true; }
export function allowSaving(key: WorkspaceKey): void {
  window.sessionStorage.removeItem(HANDOFF);
  Object.assign(state(), { key, choiceRequired: false });
  window.dispatchEvent(new Event(EVENT));
}
export function prepareLayoutHandoff(key: WorkspaceKey, layout: HostLayout): void {
  window.sessionStorage.setItem(HANDOFF, JSON.stringify({ key, layout, sourceDocument: state().documentId }));
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
function samePanes(live: HostLayout | null, saved: HostLayout | undefined): boolean {
  // Focus can change before the first poll; that does not change the saved panes.
  return !!live && !!saved && canonical(live.root) === canonical(saved.root);
}
function rendered(live: HostLayout): boolean {
  const expected = panesOf(live.root).map((pane) => pane.paneId);
  // Stock bb bypasses SplitTree for one pane and emits no pane-id element.
  // The caller verifies that pane's route instead.
  if (expected.length === 1) return true;
  const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-split-pane-id]"));
  return expected.every((id) => elements.some((pane) => pane.dataset.splitPaneId === id)) &&
    elements.some((pane) => pane.dataset.splitPaneId === live.focusedPaneId && pane.dataset.focused === "true");
}

/** Resume automatically when the saved panes are actually restored, including a
 * later visit with no handoff. Never accept a handoff in its outgoing document. */
export function acceptLayoutHandoff(): void {
  const store = readStore();
  const active = currentKey(store);
  const project = store.active;
  const live = readHostLayout();
  let outgoing = false;
  const raw = window.sessionStorage.getItem(HANDOFF);
  if (raw) {
    try {
      const pending = JSON.parse(raw);
      if (pending?.key !== active) window.sessionStorage.removeItem(HANDOFF);
      else outgoing = pending.sourceDocument === state().documentId;
    } catch {
      console.warn("Could not read workspace restoration handoff");
      window.sessionStorage.removeItem(HANDOFF);
    }
  }
  const restored = !!active && !!project && samePanes(live, store.layouts[active]) && !!live &&
    (panesOf(live.root).length > 1 || routeMatchesLayout(window.location.pathname, live, project));
  if (active && !canSave(active) && !outgoing && restored && live && rendered(live)) allowSaving(active);
  // No prompt while an ordinary restored layout is waiting for its first paint.
  // A different live layout remains protected and visibly requires a choice.
  const choiceRequired = !!active && !!store.layouts[active] && !canSave(active) && !!live && !restored && !outgoing;
  if (state().choiceRequired !== choiceRequired) {
    state().choiceRequired = choiceRequired;
    window.dispatchEvent(new Event(EVENT));
  }
}
export function savingEvent(): string { return EVENT; }
