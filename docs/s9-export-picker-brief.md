# Brief — export folder destination picker (Atlas-root handoff smoothing)

**Date**: 2026-07-16. Orchestrator: Skeld. Executor: you (Opus).
**Repo/branch**: `C:\Users\Titus\Development\OnlyWorlds\obsidian-plugin\`, branch `phase-bc`.
**Context doc**: `docs/atlas-handoff-design.md` (read it — explains WHY the plugin can't auto-detect Atlas, and that a destination picker is the chosen smoothing).

## The change

Today `Commands/ExportFolderCommand.ts` writes the OnlyWorlds folder to `OW-folder-export/<name>/` INSIDE the vault (vault API). Add a **destination choice** so a user can write the export straight into their Atlas root (`…/onlyworlds-atlas/`), making Atlas handoff one step instead of export-then-move-by-hand.

## Rulings

**R1 — Two destinations, user picks at export time:**
- (default) **In the vault** — current behavior exactly, `OW-folder-export/<folderName>/`, vault API. Keep this the zero-friction default.
- **Choose a folder…** — open Electron's native directory picker (`require('electron').remote?.dialog` is gone in modern Electron; use `this.app` → the correct modern path: `const { remote } = require('@electron/remote')` is NOT bundled. Instead use the dialog via `(window as any).electron?.remote?.dialog?.showOpenDialogSync` guardedly, and if unavailable, FALL BACK to a text-input modal where the user pastes an absolute path). Probe what's actually available in this Obsidian version FIRST (log `typeof require`, `require('electron')`) before committing to an API. Desktop-only — if `Platform.isMobile`, hide the "Choose a folder" option entirely (mobile has no Atlas).

**R2 — Writing outside the vault uses node `fs/promises`**, not the vault API (vault API can't write outside the vault root). Inside-vault destination keeps using the vault API. Factor the actual file-writing so the element-serialization logic is shared and only the sink differs (vault.create vs fs.writeFile + fs.mkdir recursive). Absolute paths only for the external sink.

**R3 — Safety on external writes:** if the target `<dest>/<folderName>/` already exists, ABORT with a clear notice (never overwrite a folder that might be a live Atlas world). Do NOT write into a folder that contains a `.atlas` dir or a `lock` file at its top level (that's an Atlas world actively held open — the race class from the Azgaar night). Check and refuse with a helpful message.

**R4 — Completion notice** names the exact path written and, when it's the in-vault default, the next step ("move into your Atlas root, or re-run and choose that folder"). When written to an external folder, just confirm the path + "open Atlas to see it."

**R5 — Do not touch** identity/marker logic (world-id-marker.ts), the serialization functions in vault/folder-format.ts, or ImportFolderCommand.ts. This is purely about WHERE the bytes land.

## Gate (yours)
`npx tsc --noEmit --skipLibCheck` clean · `npm run build` clean · `npm test` 34/34 still green (you likely add no unit tests — the sink is I/O; if you extract a pure path-planning helper, test it). Manually reason through: does the external write actually escape the vault? (vault API silently sandboxes — that's the trap to avoid.)

## Report
Findings-first. CRITICAL: disclose exactly which Electron/dialog API you found available in this Obsidian version and how you verified it (this is the risky unknown). If the native picker isn't reachable, the paste-absolute-path fallback is an acceptable ship. Judgment calls, file list, gate results.
