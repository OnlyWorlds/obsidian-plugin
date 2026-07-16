# S9 Phase C brief — the folder bridge (import/export OnlyWorlds folders)

**Date**: 2026-07-16. **Orchestrator**: Skeld. **Executor**: you (Opus).
**Repo**: `C:\Users\Titus\Development\OnlyWorlds\obsidian-plugin\`, branch `phase-bc` (continue on it — Phase B is complete and gated there; commits 59feec9..4b05602). Purely ADDITIVE: two new commands + pure serializers. Do not modify Phase B's files except main.ts command registration and the two docs files named below.

## What this is

Two commands that make the plugin the OW Folder Format's third implementation (after Atlas and Magelet):
- **"Export as OnlyWorlds folder"** — walk a world's notes, emit a conformant world folder.
- **"Import OnlyWorlds folder"** — read a world folder, mint frontmatter notes via Phase B's `writeElement`.

User-facing language is ALWAYS "OnlyWorlds folder", never "Atlas folder" (Captain naming ruling).

## Context you MUST read first

1. `C:\Users\Titus\Carrier\Orrery\notes\2026-07-13-obsidian-atlas-integration-map.md` §4 Rail 2, §6
2. **The gold-standard folder writer**: `C:\Users\Titus\Development\OnlyWorlds\azgaar-converter\src\folder.js` — copy its conformance rules faithfully (it is live-proven against Atlas ingest, four format facts test-pinned there). Read its tests too.
3. Phase B's `vault/element-file.ts` + `vault/element-transform.ts` — import mints notes through writeElement; export reads through readElement.

## Binding rulings

**R1 — Conformance (the four live-proven Atlas-ingest facts, all MUST)**:
(a) `world.json` carries `id` + `name` (+ whatever world meta World.md holds);
(b) spatial types (`map`, `pin`, `marker`, `zone` — confirm the exact set against folder.js) live under `spatial/<type>/`, all others under `elements/<type>/`;
(c) every element body carries in-file `type`, `local_updated_at`, `created_at` (folder dialect only — these never ride the API);
(d) folder is named `<slug>-<first 8 chars of world id>`; element files `<slug>--<8-char-id-tail>.json` (filename = presentation, id inside the file = identity).

**R2 — Vault-internal I/O only**: export writes to `OW-folder-export/<folder-name>/` inside the vault; import reads a world folder the user has placed anywhere inside the vault (folder picker over candidates: any folder containing a `world.json`). No node fs, no paths outside the vault — keeps it mobile-safe and permission-clean. The user moves the exported folder into their Atlas root themselves; say so in the completion notice.

**R3 — Body/prose mapping**: export: note body → `description` (`story` for Narrative) in the element JSON; import: reverse. In BODY prose, translate `[[WikiLink]]` → `[WikiLink](ow://<type>/<uuid>)` on export where the name resolves to a known element (unresolvable stays a plain `[[name]]` literal), and `[Label](ow://type/uuid)` → `[[Name]]` on import where the uuid resolves (unresolvable keeps the ow:// form verbatim — never destroy a reference). ow:// grammar: type = case-insensitive schema name, uuid = element id.

**R4 — Extension fields round-trip verbatim** both directions (Phase B's transform already handles this — route through it, don't reimplement).

**R5 — Import safety**: import NEVER overwrites an existing note silently. If an element id already exists in the target world's notes: skip it and count it (report modal like migration's: N created / N skipped-existing / N failed). Import creates a NEW world folder under OnlyWorlds/Worlds/<world name> if absent; if a world of that name exists but with a DIFFERENT world id, abort with a clear message (never merge two worlds).

**R6 — No release machinery** (same as Phase B): no version-bump, no manifest/versions.json. Commit on phase-bc.

**R7 — Tests**: pure serializers (element JSON ↔ frontmatter-shaped object, folder layout planner, ow://↔wikilink translation) in the node harness. One round-trip test: build a small world in memory → export serializers → import serializers → object equality (ids, links, extension keys, story/description). Conformance pins for all four R1 facts. `npm test` green.

**R8 — Smoke checklist**: append a "G. Folder bridge" section to `docs/SMOKE-CHECKLIST.md`: export a world → move the folder into the Atlas root → open Atlas → the world appears with elements intact (THE cross-tool proof, Captain runs it); import the same folder back into a fresh vault → notes appear in frontmatter format.

## Gate (yours, before reporting)

`npx tsc --noEmit --skipLibCheck` clean · `npm run build` succeeds · `npm test` green (Phase B's 21 must stay green).

## Report

Findings-first, judgment calls disclosed, file list, gate results. If folder.js and the integration map disagree on any conformance detail, folder.js wins (it's live-proven) — but DISCLOSE the disagreement.
