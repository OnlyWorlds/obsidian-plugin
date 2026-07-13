# Phase A — v2 Transport Rewire (design brief)

**Created**: 2026-07-13 11:22 (Skeld)
**Scope ruling (Captain, 2026-07-13)**: Phase A only this cycle — transport to v2, no note-format change. Format flip (frontmatter) + folder import/export stay open as Phases B/C. Context: `Orrery/notes/2026-07-13-obsidian-atlas-integration-map.md`.
**Goal**: move the plugin off every legacy route. After this ships, the plugin is the last legacy worldsync consumer no more.

---

## Current transport inventory (verified in source + wire, 2026-07-13)

| Surface | Route today | Dialect | Fate |
|---|---|---|---|
| Download World (`DownloadWorldCommand.ts:15`) | POST `/api/worldsync/send/` | legacy, PIN-in-body, full blob | → v2 `/changes` cursor walk |
| Upload World (`ExportWorldCommand.ts:16`) | POST `/api/worldsync/store/` | legacy, full-replace | → per-element v2 writes (diff-aware) |
| Create World (`CreateWorldCommand.ts:14`) | POST `/api/worldsync/create-world-external/` | legacy but **supported** (Atlas Make-Online uses it) | keep this cycle; revisit with `ow_a_` account-token flow (Phase B+ candidate) |
| Per-element save (`client.ts` via SDK) | `/api/worldapi/...` (v1 dialect) | v1, supported-for-years | → v2 via new adapter |

## Wire facts (probed live 2026-07-13, W11)

- `GET /api/v2/{type}` → `{"data": [...]}` envelope; slash-tolerant both forms; elements carry `type` field; auth = `API-Key`/`API-Pin` headers (same as today's client).
- `GET /api/v2/changes?limit=N` → `{cursor, changes: [{op: upsert|delete, type, id, change_seq, updated_at, element}]}` — full element bodies, **all types in one paged stream**. Param is `since` for resumption (NOT `cursor` — documented silent-replay trap, see Atlas `ow-v2-client-adapter.ts:8-34`).
- `GET /api/v2/world` → full world meta (D54). `PATCH /api/v2/world` exists for meta writes.
- v2 rejects nothing for unknown `atlas_*`/`shadow_*`/`x_*` fields (extension passthrough) — but PRESERVING them is Phase B; Phase A must at minimum **not send fields it didn't parse** (PATCH with only known fields; never PUT).

## Decision: plugin-local v2 adapter, not an SDK port

`@onlyworlds/sdk@2.2.2` is v1-only: default baseUrl `/api/worldapi` (dist line 1039), list normalization expects `{count,next,previous,results}` — v2's `{data}` envelope breaks it. Re-pointing baseUrl is not a port.

**This cycle**: a small `v2/client.ts` in-plugin (Atlas's proven pattern — thin adapter over a frozen dialect, `requestUrl` transport, documented dialect notes at top of file). Keep the SDK for what it's actually used for: `FIELD_SCHEMA` / type metadata (schema authority), NOT transport.

**Queued separately (not this repo)**: SDK v2 support as an ecosystem item — rides keel's schema pipeline; logged in `toolkit/learnings/open-improvements.md`.

## Design

### 1. `v2/client.ts` (new, ~150 lines)
- `requestUrl`-based, `API-Key`/`API-Pin` headers, `throw:false` + error-body surfacing (reuse the pattern from `client.ts:56-78`, incl. keel error `doc_url` if present).
- Methods: `listAll(type)` (paged), `changesWalk(since?)` (cursor loop, `limit=100`), `getWorld()`, `get(type,id)`, `create(type,payload)`, `update(type,id,payload)` (PATCH), `delete(type,id)`.
- Dialect notes block at top: `{data}` envelope, `since` param, bare link names on wire, extension namespaces legal.

### 2. Download World → changes walk
- First download: walk `/changes` from epoch → apply upserts per type → render notes (existing Handlebars path unchanged — Phase A does not touch the note format). `GET /world` → World.md.
- **Store the final cursor in World.md** (new `Sync Cursor` line, alongside API Key). Re-download with a cursor = incremental pull: only changed elements re-render, deletes remove notes (with confirm modal listing them — never silent-delete a user's notes).
- Fallback: if cursor line absent/invalid → full walk from epoch (idempotent; existing findElementByIdInCategory dedup already handles re-application).
- Keep the modal, drop `pin`-in-body: auth moves to headers (kills the PIN-only route class).

### 3. Upload World → per-element sweep (replaces full-replace)
- Walk vault elements (existing `collectWorldData` parse), then per element: local set vs server set (one `changesWalk` or `listAll` to build the server index):
  - local-only → `create` (client-minted UUIDv7 preserved — server keeps client ids, verified in SaveElementCommand behavior)
  - both → `update` (PATCH, only parsed fields)
  - server-only → **DO NOT delete** (v1 full-replace deleted these silently; honest-behavior ruling: report "N elements exist on server but not in vault" in the result modal, offer nothing this cycle)
- This kills the full-replace write class in the plugin — same class the worldsync scope hole lived in.
- Validation gate stays (ValidateWorldCommand before any write, unchanged).

### 4. Per-element save path
- `SaveElementCommand`/`auto-sync.ts`: swap `ObsidianOnlyWorldsClient` transport calls to the v2 client. 404-on-update → create fallback preserved (verify v2 404 shape). Read-before-PATCH stays deferred to Phase B (today's save already sends full parsed payloads; v2 PATCH with parsed-fields-only is no worse than current and strictly better than PUT).

### 5. Out of scope (explicitly)
- Note format (spans stay), extension-field preservation (needs format flip), folder import/export, `ow_a_` account flow, Create World route change, SDK port.

## Gates before release
- Wire battery against W11 (residue-free discipline: create→verify→delete probes).
- Full round-trip test: download W11 fresh → edit → save → upload sweep → re-download incremental → diff clean.
- Regression: old vault (span format, existing World.md without cursor line) downloads/uploads unchanged.
- Version: 2.3.0 (minor — transport change, no format change). **Release via npm version hook only** (never version-bump.mjs by hand).

## Sequencing
1. `v2/client.ts` + unit-shaped probes
2. Download World rewire (+ cursor persistence)
3. Upload World rewire
4. Save/auto-sync swap
5. Round-trip gate, release notes, 2.3.0
