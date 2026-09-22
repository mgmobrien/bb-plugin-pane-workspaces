// A workspace switch is a transaction with a fixed order:
//   (a) save the departing layout under the OLD active key;
//   (b) validate and apply the destination layout;
//   (c) only then commit the NEW active key (and the destination record);
//   (d) suppress layout snapshots for the whole transition, so a failed
//       apply can never overwrite either layout.
// The guard is per document. A stock-bb switch reloads the window after (c);
// the next document is protected by the saving handoff instead.

type GuardWindow = Window & { __bbWorkspacesTransition?: { until: number; timer: ReturnType<typeof setTimeout> | null } };

const DEFAULT_TIMEOUT_MS = 5000;

function guard(win: Window): NonNullable<GuardWindow["__bbWorkspacesTransition"]> {
  const g = win as GuardWindow;
  return g.__bbWorkspacesTransition ??= { until: 0, timer: null };
}

/** True while a switch is in progress; snapshots must not run. */
export function isTransitioning(win: Window = window): boolean {
  const g = guard(win);
  return g.until > Date.now();
}

export function beginTransition(win: Window = window, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  const g = guard(win);
  g.until = Date.now() + timeoutMs;
  if (g.timer) clearTimeout(g.timer);
  // Safety valve: a transition that never ends (thrown mid-way) releases itself.
  g.timer = setTimeout(() => { g.until = 0; g.timer = null; }, timeoutMs);
}

export function endTransition(win: Window = window): void {
  const g = guard(win);
  g.until = 0;
  if (g.timer) { clearTimeout(g.timer); g.timer = null; }
}

export interface SwitchSteps {
  /** (a) Save the layout on screen under the departing key. Must not throw on a no-op. */
  saveDeparting(): void;
  /** (b) Apply the destination. Return false or throw when it did not happen. */
  apply(): boolean;
  /** (c) Commit the new active key and destination record. Runs only after (b) succeeded. */
  commit(): void;
}

export type SwitchOutcome = { status: "applied" } | { status: "failed"; cause: unknown };

/**
 * Run one switch in order. The transition guard is held from before (a) until
 * after (c) or the failure, then released, unless `keepGuard` is set (the
 * caller is about to reload the window and wants no snapshot until unload).
 */
export function runSwitch(steps: SwitchSteps, options: { win?: Window; keepGuard?: boolean } = {}): SwitchOutcome {
  const win = options.win ?? window;
  beginTransition(win);
  try {
    steps.saveDeparting();
    let applied: boolean;
    try {
      applied = steps.apply();
    } catch (cause) {
      return { status: "failed", cause };
    }
    if (!applied) return { status: "failed", cause: new Error("Destination layout was not applied") };
    steps.commit();
    return { status: "applied" };
  } finally {
    if (!options.keepGuard) endTransition(win);
  }
}
