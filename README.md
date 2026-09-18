# Workspaces for bb

Return to each project with its saved arrangement of thread panes.

## Use Workspaces

- Open **Workspaces** from the sidebar or Settings → Plugins → Workspaces.
- Click a project heading or its grid button, use the footer picker, or run **Workspaces: switch workspace** from the command palette.
- Press **⌘⌥1–9** on Mac or **Ctrl+Alt+1–9** elsewhere. Numbers follow sidebar project order. Shortcuts are suppressed while typing, in terminal/editor inputs, during composition, and in modal dialogs.
- Select a thread in another project to restore that project's workspace with the thread focused. Same-project clicks and Cmd/Ctrl-click keep bb's normal behavior, including mixed-project layouts.

Layouts are stored in this browser's local storage, not on the bb server. They do not sync across devices. Stock bb reloads the window when switching; hosts exposing the experimental split-layout hook can switch without a reload. On stock bb, navigate to another project before double-clicking a thread to rename it.

## Protect and recover layouts

Matching restored panes resume saving automatically. If the live layout differs from a saved workspace, choose **Restore saved panes** or **Keep current panes**. Management pages for Workspaces, Compact UI and Thread nicknames are excluded from snapshots, including their Settings pages.

**Restore previous layout** recovers one previous revision per project. Later changes can replace that revision; this is not an unlimited backup history. **Forget saved layout** resets the saved arrangement. Threads confirmed deleted by the index are removed when restoring.

## Workspace colors

The active project's sidebar heading has a colored icon, title, background and rails; inactive headings remain distinguishable. Install [Compact UI](https://github.com/mgmobrien/bb-plugin-compact-ui) separately to configure the shared accent from its sidebar page or Settings. Without it, Workspaces uses bb's native green. The header gradient and editor-focus glow work with either one thread pane or a split layout. Compact UI’s Pane header color and Text input glow toggles can turn those accent treatments off independently.

## Install from source

Requires bb 0.42+ and plugin SDK 0.4.47. Developed against bb 0.42.1.

```sh
git clone https://github.com/mgmobrien/bb-plugin-workspaces.git
cd bb-plugin-workspaces
npm ci
npm run typecheck
npm run build
bb plugin install .
```

Keep the source directory in a durable location. Disable the plugin in bb to remove its controls; browser-local saved layouts remain.

## Compatibility and limitations

Workspaces uses internal host storage, sidebar attributes and the desktop browser-visibility bridge. Future bb changes may require updates. The thread index currently covers up to 400 unarchived threads. Local layouts are not portable backups.

Before a stock desktop reload, the plugin hides native browser views whose IDs it can read from persisted panel records. It preserves browser tabs and URLs. Unknown records are skipped with a warning; a failed visibility call stops the reload and reports an error. Views absent from readable records cannot be discovered this way. The experimental instant-switch path uses normal host cleanup.

The implementation and [upstream investigation](docs/upstream-notes.md) explain the host integrations. Third-party scaffold notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Built with **MattBot — Matt’s AI assistant (GPT-6 Astra today)**.
