# Smoke checklist — S9 Phase B (frontmatter flip)

> **Run this on a COPY of your vault or a throwaway vault FIRST, your real vault SECOND.**
> The migration writes a backup, but the whole point of this phase is that it broke last
> time — verify on a disposable copy before you trust it with a world you care about.

The unit tests (`npm test`) cover the pure serialization logic. The vault/Obsidian
wiring can only be verified by hand on a real vault. This is the exact click-path
to run before release. Do it on a THROWAWAY copy of a real world first (the
migration writes a backup, but verify on a copy anyway).

Prereqs: build the plugin (`npm run build`), copy `main.js` + `manifest.json` +
`styles.css` into a test vault's `.obsidian/plugins/onlyworlds/`, enable it.
Have a world API key + PIN ready. Ideally use a world that already has some
`atlas_*` / `shadow_*` extension fields on at least one element (round-trip proof).

## A. Download writes frontmatter (API -> note)

1. Command palette -> **OnlyWorlds: Download World**. Enter key + PIN.
2. Open any downloaded element note. Confirm:
   - [ ] It has YAML **frontmatter** (Properties panel shows `id`, `name`, and typed
         fields) — NOT `<span class="...">` lines in the body.
   - [ ] Link fields are IDs: a single link is one value; a multi link is a **YAML
         list** (Properties shows multiple chips), never a comma-joined string.
   - [ ] The body holds the description text (for a **Narrative** note, the body is
         the `story` text; `description` remains a Property).
   - [ ] If the element had `atlas_*` / `shadow_*` / `x_*` fields on the server,
         they appear verbatim in the frontmatter.

## B. Migration (span -> frontmatter) with backup

Use a world whose notes are still in the OLD span format (an old vault, or restore
a pre-2.4 note).

3. Command palette -> **OnlyWorlds: Migrate world notes to frontmatter**. Pick the world.
4. In the report modal, confirm:
   - [ ] Counts shown: N converted / N skipped / N failed.
   - [ ] The backup folder path is named (`OW-backup-<world>-<timestamp>/`).
5. In the file explorer, confirm the backup folder exists and contains copies of the
   original notes under their `Elements/<Category>/` structure. **Open one backup file
   and confirm it still has the old span format** (this is your undo).
6. Open a migrated note. Confirm it is now frontmatter (as in A2), links preserved as IDs.
7. Run the migrate command **again** on the same world. Confirm:
   - [ ] All notes report as **skipped** (already frontmatter) — idempotent, no changes,
         a fresh backup folder is still made.

## C. Edit + sync (note -> API), read-before-PATCH

8. Turn on auto-sync (Settings -> OnlyWorlds -> Auto-sync) OR use **Save Element**.
9. Edit a migrated note: change the body text and add/remove a value on a multi-link
   Property.
10. Save/sync. Confirm the status bar/ribbon shows syncing -> synced (or run Save Element
    and see the "saved" notice).
11. Save the SAME note again without changing anything. Confirm:
    - [ ] Notice reads "already up to date" (read-before-PATCH detected no diff).

## D. Re-download confirms nothing lost, extension fields intact

12. Run **Download World** again (it is incremental — pulls only changed elements).
13. Open the element you edited in step 9. Confirm:
    - [ ] Your body edit is present.
    - [ ] Your multi-link change is present, still as a YAML list of IDs.
    - [ ] **Extension fields (`atlas_*`/`shadow_*`/`x_*`) are STILL present and unchanged.**
          This is the data-loss class this phase exists to kill — verify it explicitly.

## E. Linking + rename

14. On an element note, run **OnlyWorlds: Link Elements**. Confirm:
    - [ ] A field picker lists the element's link fields (single + multi).
    - [ ] Choosing a field shows a picker of target-type elements (by name).
    - [ ] Selecting writes the ID into the Property (single = one value; multi = added
          to the list without dropping existing values).
15. Rename an element note file. Confirm:
    - [ ] The frontmatter `name` Property updates to match the new filename (only when it
          previously matched the old filename).

## F. Create

16. Run **OnlyWorlds: Create Element**, pick a type + name. Confirm:
    - [ ] The new note opens in **frontmatter** format with `id` + `name`, empty body,
          in the correct (count-suffixed) category folder.

## Regression watch (mixed-format worlds)

17. In a world with BOTH migrated (frontmatter) and un-migrated (span) notes:
    - [ ] **Upload World** completes and pushes both correctly (frontmatter via the
          reader, span via the legacy parser). **Check the count in the upload
          notice matches your element count** — a silent skip looks like success
          (this exact class was caught and fixed at the gate; verify it stays dead).
    - [ ] **Copy World to Clipboard** completes; paste the clipboard into a text
          editor and spot-check elements carry their `id`.

Known limitation to eyeball, not a blocker: **Validate World** is still a span-format
linter. Run on a migrated (frontmatter) world it will report false "missing Id / Name"
errors. It performs no writes (diagnostic only). A frontmatter-aware validator against
the SDK FIELD_SCHEMA is deferred — see the S9 report.

## G. Folder bridge (S9 Phase C — export/import OnlyWorlds folders)

This is THE cross-tool proof: the plugin becomes the OnlyWorlds folder format's
fourth implementation (after Atlas, Magelet, azgaar-converter). Run on a
migrated (frontmatter) world for the cleanest result; span notes export too
(read-tolerant) but frontmatter is the target format.

**G1. Export -> Atlas (the cross-tool proof — Captain runs it).**

18. Run **OnlyWorlds: Export as OnlyWorlds folder**, pick a world. Confirm the
    report modal shows `N files written (incl. world.json)` with 0 skipped.
    - [ ] A folder `OW-folder-export/<slug>-<id8>/` now exists in the vault.
    - [ ] It contains `world.json` (open it: has `id` uuid + `name`), an
          `elements/<type>/` tree, and — if the world has maps/pins/zones/markers
          — a `spatial/<type>/` tree.
    - [ ] Open one element JSON: it carries `type`, `local_updated_at`,
          `created_at` at the top, plus the element's real `id` and fields.
    - [ ] Filenames are `<slug>--<8-char-tail>.json`.
19. Move that folder OUT of the vault and INTO your Atlas root. Open Atlas.
    - [ ] The world appears with its elements intact (names, descriptions, links).
    - [ ] A description that referenced another element renders as an Atlas
          mention (the `[[wikilink]]` became `ow://type/uuid` on export).

**G2. Import -> fresh vault (deterministic inverse).**

20. In a FRESH/throwaway vault with the plugin installed, place the SAME exported
    folder anywhere inside the vault. Run **OnlyWorlds: Import OnlyWorlds folder**
    and pick it. Confirm the report shows `N created / 0 skipped / 0 failed`.
    - [ ] Notes appear under `OnlyWorlds/Worlds/<world name>/Elements/<Type>/` in
          **frontmatter** format, carrying their original `id`.
    - [ ] `ow://` mentions in bodies became `[[wikilinks]]` that resolve.
    - [ ] Extension keys (`atlas_*`/`shadow_*`/`x_*`), if any, survived verbatim.
21. Run the SAME import AGAIN into the same vault.
    - [ ] Report shows `0 created / N skipped (id already present) / 0 failed` —
          existing notes are never overwritten (R5).
22. Edit `world.json`'s `id` to a different uuid, then import once more.
    - [ ] Import ABORTS with a "different id — must not merge" message (R5).
