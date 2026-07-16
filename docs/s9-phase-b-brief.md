# S9 Phase B brief — the frontmatter flip

**Date**: 2026-07-16. **Orchestrator**: Skeld. **Executor**: you (Opus).
**Repo**: `C:\Users\Titus\Development\OnlyWorlds\obsidian-plugin\` — work on branch `phase-bc` (create from main). ~1,100 installs, NO unit tests, and this exact migration BROKE THINGS in a previous attempt — Captain's manual smoke test is the release gate, not your build. Your job is to make that smoke trivially passable.

## Context you MUST read first

1. `C:\Users\Titus\Carrier\Orrery\notes\2026-07-13-obsidian-atlas-integration-map.md` — §3 (findings), §5 Phase B, §6
2. `C:\Users\Titus\Carrier\Orrery\notes\2026-07-13-obsidian-link-archaeology.md` — the four regex-brittleness classes you are killing
3. `C:\Users\Titus\Carrier\Orrery\product\tools\obsidian-plugin-redesign.md` — Phase 3 migration design (backup-first)
4. The repo itself: `vault/element-file.ts` (the dormant destination format — read path wired, write path never called), `Listeners/NoteLinker.ts`, `Commands/`, `Scripts/WorldService.ts`, `sync/auto-sync.ts`, `client-v2.ts`

## Binding rulings

**R1 — Format**: notes become YAML frontmatter (id + typed fields via SDK FIELD_SCHEMA) + freeform body, exactly the `vault/element-file.ts` format. Wire its `writeElement` into ALL write paths (create, download, sync); its read path becomes the only parser. The three span-format regex parsers retire — but READ tolerance for the old span format stays this release (a note not yet migrated must not be data loss; parse old format on read, write new format always).

**R2 — Migration**: a command "Migrate world notes to frontmatter". Sequence: (1) full backup of the world's element notes into `OW-backup-<world>-<timestamp>/` inside the vault BEFORE touching anything — abort entirely if backup fails; (2) convert each note span→frontmatter; (3) end report modal: N converted, N skipped (already frontmatter), N failed with filenames. Idempotent — running twice is a no-op. Reversibility = the backup folder; say so in the report modal.

**R3 — Extension preservation (the data-loss class this phase exists to kill)**: unknown frontmatter keys, and specifically ANY key prefixed `atlas_`/`shadow_`/`x_`, round-trip verbatim: API→note keeps them in frontmatter; note→API sends them back unchanged. Foreign namespaced fields are READ-ONLY — never rewrite, never drop (Temper's law; Atlas self-healing depends on it). Plugin's own future state uses `x_obsidian_*` (do not add fields now; just don't collide).

**R4 — Linking**: NoteLinker's detection moves from rendered-HTML regex to `app.metadataCache` frontmatter. Link fields hold IDs (single: string; multi: YAML list — never comma-joined strings). Display resolution id→name via the world index. Wikilink insertion in the BODY stays as-is for prose; the typed link FIELDS live in frontmatter. This kills all four archaeology classes at the root.

**R5 — Body mapping**: body = `description` for all types EXCEPT Narrative, where body = `story` (Captain ruling 2026-07-13 §7.3 + Temper's contract affirmation). On read: story→body; on write: body→story. Do NOT advertise the Atlas-writing-room roundtrip anywhere in UI copy (Atlas-side coherence bout not yet shipped).

**R6 — No release machinery**: never touch version-bump.mjs, manifest.json version, or versions.json. Branch `phase-bc`, commits allowed on the branch (this repo has no staging law), no push unless I say so.

**R7 — Sync safety**: upload paths do read-before-PATCH merge (fetch current, merge changed fields, PATCH) — never blind full-object PUT of possibly-stale data. The /changes incremental download from 2.3.0 stays the transport; only the note serialization layer changes.

**R8 — Testability**: extract the pure logic (frontmatter serialize/parse, span→frontmatter transform, extension-key filter, link-value normalization) into functions with no Obsidian imports, and write a node test harness for them (vitest or plain node:test — your call; `npm test` must run it). The UI/vault wiring can only be smoke-tested — for that, write `docs/SMOKE-CHECKLIST.md`: the exact click-path Captain runs on a real vault (backup → migrate → verify note → edit → sync → re-download → confirm nothing lost, extension fields intact).

## Gate (yours, before reporting)

`npx tsc --noEmit` clean · esbuild production build succeeds · `npm test` green · old-format note reads correctly (test with a fixture string of the real span format — copy one from the repo's templates/history).

## Report

Findings-first. Every judgment call disclosed, especially anywhere the dormant element-file.ts turned out incomplete or the span parser had cases the archaeology missed. If the surface area explodes beyond this brief (the 2026-07-11 pull happened for exactly that), STOP and report rather than half-shipping — that outcome is a valid deliverable.
