# Core smoke — S9 Obsidian interop (the 10-minute pass)

The tight version of SMOKE-CHECKLIST.md — the load-bearing behaviors only.
**Throwaway/copy vault first.** Reload Obsidian (Ctrl+R) after each `npm run build`.

What Skeld already verified by execution (you don't need to re-run these):
- ✅ **Migration correctness** — Captain's real MessWorld run audited: 22/22 notes, 0 span residue, every id/field/body matches the backup, via the plugin's own transform.
- ✅ **Extension-field round-trip** — `atlas_*`/`shadow_*`/`x_*` incl. nested objects survive API→note→API verbatim (the data-loss class this phase kills), via the plugin's own transform.
- ✅ **34/34 unit tests**, tsc + build clean.

## The human-only pass (what code can't verify)

1. **Download → frontmatter** (2 min). Download World on a fresh vault with a LIVE key.
   - [ ] Notes have YAML frontmatter (Properties panel), not `<span>` bodies.
   - [ ] Multi-links are YAML lists (multiple chips); single links one value.
   - [ ] Element count in the notice looks right.
   *(Gotcha fixed today: if a vault has a stale sync cursor but no notes, download now pulls cold instead of writing nothing — retest by re-downloading into an emptied world folder.)*

2. **Edit → save → no-op save** (1 min).
   - [ ] Edit a note body + a multi-link, Save Element → "saved".
   - [ ] Save again unchanged → "already up to date" (read-before-PATCH).
   *(Needs a LIVE world key. "No valid API-Key" = the World.md key is dead/absent on the server — a data problem, not a plugin bug. Verify the key works: `curl .../api/v2/world -H "API-Key: <key>" -H "API-Pin: <pin>"`.)*

3. **Migration on a REAL old vault** (2 min). Copy an old span-format vault, migrate one world.
   - [ ] Report: N converted / N skipped / N failed (+ any unresolved-links list).
   - [ ] Backup folder `OW-backup-<world>-<ts>/` exists AND holds the old span notes.
   - [ ] Run again → all "skipped" (idempotent).

4. **Folder bridge → Atlas** (3 min — THE cross-tool proof).
   - [ ] Export as OnlyWorlds folder → pick a destination. **Test both**: (i) vault default lands in `OW-folder-export/`; (ii) "Choose a folder…" → pick your `…/onlyworlds-atlas/` root → the folder lands there directly. **Watch which dialog path fires** — if the native OS picker doesn't open, you get a paste-absolute-path modal (the fallback); note which, so we know what this Obsidian build exposes (the one unverified-from-outside piece).
     - [ ] Refusal check: try exporting into a folder that already holds that world folder → refused, not overwritten.
   - [ ] Open Atlas → the world appears with elements, descriptions, links intact.
   - [ ] Import the same folder into a fresh vault → frontmatter notes with original ids; re-import → all "skipped" (never overwrites); different world.json id, same name → aborts.

## Known limitations (expected, not bugs)
- **Validate World** is still a span linter → false "missing Id/Name" on migrated worlds. Read-only. Next-cycle fix.
- **Paste World** still writes span-format notes (self-contained clipboard path, untouched this round).
- **Atlas root is not auto-detectable** from the plugin (browser sandbox — see `docs/atlas-handoff-design.md`); the destination picker is the smoothing.
