# Obsidian → Atlas folder handoff — design finding

**Date**: 2026-07-16 (Captain's smoke; Atlas source read in the Forge)
**Question Captain raised**: "Export as OnlyWorlds folder" wrote to `OW-folder-export/` inside the vault, then I told him to "move it into your Atlas root" — but the plugin has no idea where that is. Can we auto-detect / picker / smooth this?

## How Atlas actually works (from `Carrier/Forge/tools/atlas/`)

- Atlas root = ONE user-chosen folder per browser profile, marked with a `.atlas-root` dotfile. It holds many world subfolders. Default wrapper name `onlyworlds-atlas/` (constants.ts `ATLAS_ROOT_SUBFOLDER`). Captain's is `Desktop\TESTOWFOLDER\onlyworlds-atlas`.
- Atlas discovers worlds by **scanning its root for subfolders that contain a valid `world.json`** (`discoverWorldsInRoot`, atlas-root-flow.ts:106). A conformant world folder dropped into the root → picked up on next open. This is exactly what our Phase C export emits. **The handoff genuinely works** (Captain confirmed: moved folder → opened in Atlas → elements loaded).
- Atlas is a **browser app on the File System Access API** (`showDirectoryPicker`, directory-picker.ts). It can ONLY ever see files under the root the user granted it. It has no filesystem path and no ambient access.

## Why the plugin CANNOT auto-detect the Atlas root

- The plugin runs in Obsidian (Electron/node-fs, real paths). Atlas runs in a browser sandbox (opaque handles persisted in IndexedDB, no path exposed). **There is no shared, discoverable location** — Atlas's root can be anywhere on disk (Desktop, Documents, a cloud-synced folder), chosen per browser profile, and its handle is not readable outside that browser.
- So "auto-set to Atlas if possible" is not achievable from the plugin's side. Confirmed against Atlas source, not assumed.

## What we CAN do (ranked)

1. **★ SHIPPED THIS PASS — folder location picker on export.** The export command now lets the user pick WHERE the folder is written (a real OS folder picker), defaulting to the vault-internal `OW-folder-export/`. A user who points it straight at `…/onlyworlds-atlas/` gets a one-step handoff: export lands in the Atlas root, Atlas sees it on next open. This is the honest, robust smoothing — the user knows where their Atlas root is; we let them target it directly instead of export-then-move.
2. **Clear completion notice** naming the exact next step and the two paths ("Written to <path>. To open in Atlas: move this folder into your Atlas root — the folder you picked when setting up Atlas, e.g. …/onlyworlds-atlas/ — or re-run export and pick that folder directly.").
3. **DEFERRED (future, needs a real signal)**: remember the last-used export location in settings so repeat exports default to the Atlas root once chosen. Cheap, but adds a settings field — do it when export is used enough to warrant it.

## Not doing

- No `.atlas-root` writing / Atlas-root creation from the plugin — that's Atlas's job and its marker semantics; the plugin writing Atlas's control files would be the exact foreign-tool-owns-another's-dotfiles anti-pattern.
- No filesystem crawl for `.atlas-root` — slow, permission-fraught, and a browser Atlas root may be a folder node can't even reach.
