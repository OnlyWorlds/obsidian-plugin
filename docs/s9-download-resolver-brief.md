# S9 fix — resolve link names at download time (from the payload, not the cache)

**Date**: 2026-07-16. Orchestrator: Skeld. Executor: you (Opus).
**Repo/branch**: `C:\Users\Titus\Development\OnlyWorlds\obsidian-plugin\`, branch `phase-bc`.

## The bug (fully diagnosed — do not re-diagnose, just fix)

The readability bout (commit 52bf5af) made link fields render as `[[Name]]` wikilinks. But on a real download, almost every link field stayed a raw UUID. Captain's screenshot: Admiral Fluffington had `location`, `species`, `objects`, etc. all as bare UUIDs, only one field resolved.

**Root cause**: `writeElement` (vault/element-file.ts) resolves ids→names via `buildIdToNameResolver`, which reads `app.metadataCache.getFileCache(f)?.frontmatter`. During a download, notes are written one-by-one; a freshly-written sibling note is NOT yet indexed in metadataCache, so the resolver's index is nearly empty → `resolveIdToName(id)` returns null → `renderLinkId` keeps the raw id. Cache timing, not logic.

**The old (pre-refactor) format avoided this**: its `linkifyContent`/`buildVaultNameIndex`/`findNameById` (still visible in DownloadWorldCommand.ts history) resolved names from the **in-memory download payload** — which already holds every element's id AND name — falling back to a vault scan only for ids not in the payload. We restore that approach for the frontmatter format.

## The fix (three changes)

**R1 — `writeElement` accepts an injected id→name map (vault/element-file.ts).**
Add `idToName?: (id: string) => string | null` to `WriteElementOpts`. When present, `writeElement` passes it as `resolveIdToName` to `apiDataToFrontmatter` INSTEAD OF building the cache-scanning `buildIdToNameResolver`. When absent, keep today's `buildIdToNameResolver` behavior (back-compat for callers like Migrate that don't have a payload map).

**R2 — `DownloadWorldCommand.generateElementNotes` builds ONE complete id→name map and threads it into every `writeElement` call.**
Build the map from `worldData` (all downloaded elements: `{id -> name}` across every category) BEFORE the write loop. **Incremental-pull caveat**: an incremental download's `worldData` carries only CHANGED elements, so a link may point at an element not in this pull. So the map must ALSO fall back to existing vault notes: after seeding from `worldData`, scan existing element notes for this world (raw file frontmatter id+name, NOT metadataCache — see R3) and add any ids not already in the map. Payload wins over disk (freshest names). Pass this merged map via the new `idToName` opt.

**R3 — the disk-scan fallback reads RAW file content, never metadataCache.**
The whole bug is cache unreliability mid-download. The fallback that scans existing notes must read each file's frontmatter by reading the file (`vault.read` or `vault.cachedRead`) and parsing the `---` block for `id:` and `name:`, NOT `metadataCache.getFileCache`. A tiny raw parser is fine (id + name lines). This makes resolution independent of cache-index timing entirely.

## Portability check (the POINT — verify, don't assume)

After the fix, the resulting note's link fields must be plain `[[Name]]` wikilinks that Obsidian resolves BY FILENAME with no plugin involved — i.e. the vault is movable and links stay real. Confirm in your report: a `[[Name]]` in frontmatter is a standard Obsidian wikilink (it is — but state that you verified the written form is `[[Bare Name]]`, not `[[full/path/Name]]` or `[[id]]`).

## Rulings
- Unresolvable id (not in payload, not on disk) stays a raw id — never `[[Unknown]]`, never dropped. (renderLinkId already does this via the null return.)
- Names with filesystem-unsafe chars: the wikilink target is the NAME as Obsidian sees the note (its basename). If a name was sanitized for the filename, the wikilink must match the actual note basename so it resolves. Check how writeElement names the file and make the id→name map return the value that resolves (basename if that's what the file is called). Disclose how you handled this.
- Extension fields, empty-omit, id/name/image_url ordering from 52bf5af all stay exactly as-is.

## Tests (node harness)
- `apiDataToFrontmatter` with an injected `resolveIdToName` map: single + multi links render `[[Name]]`; id absent from map stays raw. (May already be covered by 52bf5af's tests — extend if the injected-map path isn't directly tested.)
- A raw-frontmatter parser unit (id/name extraction from a `---` block) if you add one.

## Gate (yours)
`npx tsc --noEmit --skipLibCheck` clean · `npm run build` clean · `npm test` all green (54 existing + any new). Commit on phase-bc with pathspec (`git commit -- <files>`, NEVER `git add -A` — shared tree). Never push, never touch version-bump.mjs/manifest/versions.json.

## Report
Findings-first. Confirm the portability check (written form is `[[Bare Name]]`). Disclose the sanitized-name handling. Note whether incremental-pull fallback was needed/tested. File list, gate results.
