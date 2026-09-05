# Core smoke — the 10-minute pass

The tight version of SMOKE-CHECKLIST.md — the load-bearing behaviors only.
**Throwaway/copy vault first.** Reload Obsidian (Ctrl+R) after each `npm run build`.

---

## ★★ MOBILE pass (2026-09-05) — the phone checks, run on a real device

Why this section exists: a user on iOS reported that modal buttons sit behind
the keyboard, unreachable. **None of this is verifiable on desktop** — the
whole fix is gated on `Platform.isMobile`, so a desktop run exercises nothing.
Obsidian mobile + a synced test vault; a phone, not a tablet, for steps 2-3
(the auto-focus suppression is `isPhone`, deliberately).

1. **★ The reported bug: Create World is usable.** Ribbon → Create World.
   - [ ] The dialog fits the screen; you can scroll it.
   - [ ] **CANCEL / CREATE LOCAL-ONLY / CREATE WITH ACCOUNT are all visible and
         tappable while the keyboard is up.** This is the bug — if any button
         is behind the keyboard, the fix has not worked.
   - [ ] Tapping CREATE LOCAL-ONLY actually creates the world (the buttons kept
         their listeners when they were moved into the footer).

2. **The keyboard does not open by itself.** Open Create World again.
   - [ ] On a PHONE the keyboard stays down until you tap a field.
   - [ ] Tapping the name field opens it, and the buttons stay reachable.

3. **A world with local worlds present.** Create a local-only world first, then
   reopen Create World.
   - [ ] The 'take a local world online' section and its TAKE ONLINE button are
         reachable by scrolling. *(This button is a bare child after the main
         button row — the case the first implementation got wrong.)*

4. **★ Link Elements — the list still scrolls.** Open an element note, Link
   Elements on a multi-link field with 20+ candidates.
   - [ ] The element list scrolls.
   - [ ] **The list is NOT pinned to the bottom as a footer** — only Done is.
   - [ ] On a SINGLE-link field (no Done button) the list scrolls normally and
         nothing is pinned. *(Naive footer-picking breaks exactly here.)*

5. **Download World.** Ribbon → Download World with a real key.
   - [ ] Key field reachable, buttons reachable with the keyboard up.

6. **Manage Fields.** Open it on a Character.
   - [ ] The long field list scrolls; the action row stays put.

7. **Desktop did not regress.** Same vault on desktop.
   - [ ] Modals look and behave exactly as before (nothing is gated on mobile
         there — but confirm, because this touched all 24 modals).

---

## ★ 3.2.0 pass (2026-08-22) — run THIS first; the S9 section below is older

The v3.2 format (text fields as `###` body sections) changed what a note looks
like, so the S9 steps below still describe 3.0 notes. These are the checks that
found real bugs on 3.2.0's own test day — every one of them caught something:

1. **New element carries its whole shape.** Create a Character.
   - [ ] ~33 properties (base → numbers → links) AND 6 `###` body sections.
   - [ ] Headings fold. A blank line under each, including empty sections.
   *(3.0/3.1 created `name` + `id` only — the bug this release exists to fix.)*

2. **★ Frontmatter stays frontmatter.** Add Custom Field on a fresh note, then
   again with a name that already exists.
   - [ ] The note still renders Properties, NOT plain text.
   *(The 2026-08-22 corruption: `processFrontMatter` left blank lines above the
   `---`, which stops Obsidian seeing it as frontmatter, and every later write
   buried it deeper. Never reintroduce that call — see CLAUDE.md's write rule.)*

3. **Manage Fields, both directions.** Toggle a field off, then back ON.
   - [ ] It comes back. *(Two writers racing lost the re-tick.)*
   - [ ] A field holding text has a DISABLED toggle. **If you can untick it and
         lose prose, stop and fix that before anything else.**
   - [ ] Scroll position holds while toggling.

4. **Download writes the full field set.** Download a world with sparse elements.
   - [ ] Notes show every field, not only the populated ones.

5. **Same key = same world.** Download using the key of a world already in the
   vault under a DIFFERENT folder name.
   - [ ] It reuses that folder; no duplicate world.

6. **Update World to Latest Format** on a pre-3.2 world.
   - [ ] Dry-run report FIRST; nothing written until confirmed.
   - [ ] Run twice → second run reports nothing to do.

7. **Link to a not-yet-uploaded element → Save Element.**
   - [ ] A notice names the element and says to upload first.

---

## S9 (3.0) pass — kept for the sync/migration paths it still covers

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
