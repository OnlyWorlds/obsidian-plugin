# S9 readability bout — wikilink display + note layout

**Date**: 2026-07-16. Orchestrator: Skeld. Executor: you (Opus).
**Repo/branch**: `C:\Users\Titus\Development\OnlyWorlds\obsidian-plugin\`, branch `phase-bc`.
**Why**: Captain's smoke found the frontmatter flip technically correct but LESS USABLE than the old span format — link fields show raw UUIDs (dead text, not clickable, invisible to Obsidian's graph). The old format had clickable `[[Name]]` links; that was the whole point. A probe (now removed) PROVED the fix is safe at scale on 1011 real links: 0 duplicate ids, 0 name collisions via Obsidian's path-aware resolver, resolution ≈ 100% (the 1 miss was a genuinely dangling ref). So: store link fields as `[[Name]]` wikilinks, resolve identity from the linked note's own `id` — NO separate id-map.

## The four changes

### R1 — Link fields become `[[Name]]` wikilinks (the core)

**On WRITE (API→note, `writeElement` / `apiDataToFrontmatter` in vault/element-transform.ts + element-file.ts):**
- Single-link fields: value = `"[[TargetName]]"` (a string), resolved from the target element's id via the vault id→name index. If the id has no local note, keep the raw id string (graceful — dangling/cross-world links never lost).
- Multi-link fields: array of `"[[TargetName]]"` strings, same resolution per id, same raw-id fallback per unresolved.
- You need an id→name resolver over the world's notes. One already exists: `buildVaultLinkResolver` (name→id) in element-file.ts; you need the INVERSE (id→name). Build an id→name index the same way (metadataCache frontmatter id + name) and thread it into `apiDataToFrontmatter` (add an optional resolver param; when absent, fall back to today's raw-id behavior so pure unit tests without a vault still pass).

**On READ (note→API, `readElement` / `frontmatterToPayloadFields`):**
- A link field value that is `"[[Name]]"` (or `[[Name|Alias]]`) resolves to the target note's `id` via `app.metadataCache.getFirstLinkpathDest(name, sourceFilePath)` → that file's frontmatter `id`. Path-aware (the probe proved this disambiguates same-name notes correctly).
- A link field value that is already a raw UUID string stays as-is (dangling/unmigrated tolerance).
- Unresolvable `[[Name]]` (no target file, or target has no id): drop it from the outbound id list AND surface it (return an `unresolved` list like migration does) — never silently lose a link, never guess.
- `frontmatterToPayloadFields` is pure (no Obsidian) — so the wikilink→id resolution must happen in the Obsidian-facing layer (readElement) BEFORE calling the pure function, OR pass a resolver in. Keep the pure function testable: it should accept link values that are already ids OR `[[name]]` with an injected resolver fn. Mirror how the write side injects id→name.

### R2 — Description at the TOP of the note
The body (description/story) already renders below the frontmatter — that's fine, frontmatter is always on top in Obsidian. The ASK is that the readable prose leads. Since Properties always render above body in Obsidian, "description at top" means: keep description in the BODY (it already is) — the real fix is R3/R4 making the Properties panel lean so the body prose is reached fast. NO structural change needed for R2 beyond R3/R4. **Confirm this understanding in your report** — if Captain wants description literally duplicated into the body top when it's a Property elsewhere, that's separate; do not do it now.

### R3 — Omit empty/null fields on write
`apiDataToFrontmatter` currently writes every schema field including empty strings and nulls (the `height:`, `STR:`, blank-stat clutter Captain saw). Change: SKIP a field whose value is null, `""`, or `[]` when writing frontmatter — a note carries only fields that have values. They return on next download if the server has them. EXCEPTION: never skip `id` or `name`. Extension keys: keep even if empty (they're foreign, R4/round-trip law — an empty `x_` is still a real key the owner set). Multi-links that resolve to an empty array after dropping unresolved: omit.

### R4 — OW-internal fields last
`id` and `image_url` are machine fields cluttering the panel top. `apiDataToFrontmatter` returns an object; its key ORDER drives Properties order. Put `name` first, then real content fields, then `image_url`, and `id` LAST (Obsidian shows Properties in object order). Do not hide them (can't), just order them. Keep `name`+`id` present always.

## Rulings
- **Round-trip integrity is sacred**: `[[Name]]` note → upload → download must yield the same links. The probe proved the mechanism; your unit tests must prove the code. A link that was an id and resolves to a note becomes `[[Name]]` on next download — that's expected drift toward readability, not data loss (the id is recovered from the note on upload).
- **Extension fields untouched** (R4 of the original phase): `atlas_*`/`shadow_*`/`x_*` never become wikilinks, never get dropped by the empty-omit rule.
- **Pure-vs-Obsidian split stays**: element-transform.ts has NO Obsidian imports. Resolution (metadataCache/getFirstLinkpathDest) lives in element-file.ts; the pure functions take injected resolvers.

## Tests (node harness — extend test/element-transform.test.ts)
- Write: id→`[[Name]]` for single + multi, with an injected id→name resolver; unresolved id stays raw.
- Read: `[[Name]]`→id via injected name→id resolver; `[[Name|Alias]]` resolves on Name; already-a-uuid stays; unresolvable reported not guessed.
- Empty-omit: null/""/[] fields absent from frontmatter output; id/name/extension-empty retained.
- Order: name first, id last in the emitted object.
- Round-trip: {id links} → write(resolver) → read(resolver) → same id set.

## Gate (yours)
`npx tsc --noEmit --skipLibCheck` clean · `npm run build` clean · `npm test` all green (the existing 41 + your new ones). Commit on phase-bc with pathspec (git commit -- <files>, NEVER git add -A — shared tree). Never push, never touch version-bump.mjs/manifest/versions.json.

## Report
Findings-first. Confirm your R2 reading. Disclose any place the pure/Obsidian split forced an awkward seam. If empty-omit interacts badly with the migration path or the folder-format export (which reads notes too), FLAG it — those consume readElement and must still work. File list, gate results.
