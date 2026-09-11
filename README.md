# Workspaces for bb

Save and restore a separate arrangement of thread panes for each project in [bb](https://github.com/get-bb/bb).

## Use

- Click a project name or its grid icon in the sidebar to restore that workspace.
- Plain-click a thread in another project to open that project’s workspace with the thread selected. An existing pane receives focus; otherwise the focused pane is replaced.
- Use **⌘⌥1–9** on macOS or **Ctrl+Alt+1–9** elsewhere. Numbers follow visible sidebar project order.
- Open **Workspaces: switch workspace** in the command palette, or use the sidebar footer grid.
- Cmd/Ctrl-click keeps bb’s ordinary split-opening behaviour, including deliberately mixed-project workspaces.

The plugin also adds an active-project rail and icon, shaded pane headers and a subtle glow inside the focused composer. Green follows bb’s theme by default. An optional companion can set the namespaced `--bb-workspace-accent` CSS variable; it is not required to use this plugin.

## Install from source

Requires bb 0.42 or later and Node/npm. This snapshot was exercised with bb 0.42.1 and plugin SDK 0.4.47; it depends on internal host details described below.

```sh
git clone https://github.com/mgmobrien/bb-plugin-workspaces.git
cd bb-plugin-workspaces
npm ci
npm run typecheck
npm run build
bb plugin install .
```

Keep this directory at a durable location: a local-path plugin installation reads its source here. Build output and dependencies are generated locally and are not committed.

## Storage and recovery

Layouts are stored in the browser profile’s local storage, keyed by project. They are **not** stored in the plugin’s server database and are not synchronized between machines. The backend serves an index of projects and up to 400 unarchived threads and signals index changes; it does not copy conversation bodies.

The plugin retains one previous layout per project. **Restore previous layout** restores that recovery copy. This is a single revision, not an unlimited backup history.

When the live layout does not match the saved arrangement, a prompt offers **Restore saved panes** or **Keep current panes**. Matching restores resume saving automatically. These checks do not protect against every possible host failure after acceptance.

## Compatibility and limitations

- **Stock bb reloads the renderer on a workspace switch.** The plugin writes bb’s persisted layout before the reload. A host exposing the proposed `experimental_useSplitLayout` hook can switch without reloading; this is not part of the published SDK used here.
- Sidebar integration uses bb’s DOM attributes; layout restoration and acceptance use internal storage, routes and rendered pane markers. Host updates can require plugin changes.
- Before its own desktop reloads, the plugin attempts to hide native browser views using tab IDs from persisted fixed-panel records. Unrecognized records are skipped with a warning; a failed hide call stops the switch. This does not cover reloads initiated elsewhere or views absent from readable records.
- The backend index is capped at 400 unarchived threads. Layout sanitization treats threads absent from the resolved index as unavailable, so installations above that limit need additional care before relying on saved layouts for older threads.
- Keyboard shortcuts yield to editable fields, composing/repeated events and modal/editor guards. They avoid default bb bindings but cannot inspect custom keybinding overrides.
- On stock bb, navigate to a foreign project before double-clicking a thread to rename it: the first click’s reload interrupts the double-click sequence.
- **Forget saved layout** removes a project’s current saved arrangement. The previous-revision copy can help recover it, but later writes may replace that copy.

## Upstream motivation

Two host changes would remove workarounds in this plugin:

1. A supported API to read and replace a complete split layout without reloading.
2. Native browser-view cleanup on every full host-renderer navigation, not just explicit menu/keyboard reloads.

See [the implementation notes](docs/upstream-notes.md) for the relevant source paths and verification boundaries. The proposed host patches are separate from this plugin.

## Project

Built for Matt’s bb workflow with assistance from **MattBot — Matt’s AI assistant (GPT-6 Astra today)**. This repository contains plugin source, not Matt’s projects, conversations or saved layouts.
