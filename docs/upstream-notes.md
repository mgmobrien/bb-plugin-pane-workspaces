# Host integration notes

## Applying layouts without reload

`lib/layout.ts` reads and writes bb’s `bb.splitLayout` value. `app.tsx` uses the optional `experimental_useSplitLayout` hook if present; otherwise it writes the layout, updates the route and requests a reload. The complete saved tree includes split direction, proportions, pane contents and focus.

`lib/saving.ts` distinguishes a matching restore from a mismatch before resuming saves. This is a workaround for observing host restoration, not a replacement for a supported host API.

A separate local host prototype supplies that hook. It is not included here, and this repository does not claim that published bb exposes it.

## Native browser previews

`lib/browser-preview.ts` reads known browser tab IDs from persisted fixed-panel records and uses the desktop visibility bridge before plugin-initiated reloads. It does not delete tabs or alter those records. It cannot enumerate unknown views or intercept every possible host navigation.

The proposed host-side improvement calls the existing window-scoped preparation method on main-frame, cross-document navigation. That patch belongs in bb desktop, not in this plugin.

## Evidence boundaries

The development work used source review, focused library/React fixtures and isolated Chromium CSS measurements. Matt exercised workspace switching and visual treatments in the running app. An isolated fixture proving that a reload was requested does not prove that a restarted Electron renderer restored everything correctly; a reviewed native-navigation callback does not prove native rendering end to end.

This public snapshot keeps executable plugin source identical to the locally installed accent-v1 version. Documentation was rewritten for public use. Private test artifacts, local paths, screenshots and user data are excluded.
