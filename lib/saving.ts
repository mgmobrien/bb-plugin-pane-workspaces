import { readHostLayout, readStore, panesOf, routeMatchesLayout, type HostLayout } from "./layout";

const HANDOFF = "workspaces.pending-layout.v1";
const EVENT = "workspaces:saving-changed";
type SavingState = { projectId: string | null; documentId?: string; choiceRequired?: boolean };
type SavingWindow = Window & { __bbWorkspacesSaving?: SavingState };
function state(): SavingState {
  const win = window as SavingWindow;
  const value = win.__bbWorkspacesSaving ??= { projectId: null };
  value.documentId ??= window.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return value;
}
export function canSave(projectId: string): boolean { return state().projectId === projectId; }
export function needsSavingChoice(): boolean { return state().choiceRequired === true; }
export function allowSaving(projectId: string): void {
  window.sessionStorage.removeItem(HANDOFF);
  Object.assign(state(), { projectId, choiceRequired: false });
  window.dispatchEvent(new Event(EVENT));
}
export function prepareLayoutHandoff(projectId: string, layout: HostLayout): void {
  window.sessionStorage.setItem(HANDOFF, JSON.stringify({ projectId, layout, sourceDocument: state().documentId }));
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
  const active = store.active;
  const live = readHostLayout();
  let outgoing = false;
  const raw = window.sessionStorage.getItem(HANDOFF);
  if (raw) {
    try {
      const pending = JSON.parse(raw);
      if (pending?.projectId !== active) window.sessionStorage.removeItem(HANDOFF);
      else outgoing = pending.sourceDocument === state().documentId;
    } catch {
      console.warn("Could not read workspace restoration handoff");
      window.sessionStorage.removeItem(HANDOFF);
    }
  }
  const restored = !!active && samePanes(live, store.layouts[active]) && !!live &&
    (panesOf(live.root).length > 1 || routeMatchesLayout(window.location.pathname, live, active));
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
