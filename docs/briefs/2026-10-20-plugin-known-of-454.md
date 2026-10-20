# Brief: the Obsidian plugin reads known-of stubs (OW Infra #454)

**2026-10-20 18:19** · Skeld, for an Opus executor · repo `C:/Users/Titus/Development/OnlyWorlds/obsidian-plugin` (main 9c71ccb, tag 3.6.0; about 1,100 installs, auto-updating: a wrong release reaches every vault)

## The case

Since keel PR 113 (2026-10-20) and PR 117, keel serves a player or guest key some elements as **known of**: a stub with `known_of: true` and only some fields (id, type, name, description, supertype, subtype, image_url, created_at, updated_at, change_seq, and on a Character the public fields physicality, height, weight, species, reputation). The plugin does not read `known_of` today: it would write the stub as a whole note, read every missing field as emptied, and on the next push send the stub back whole (keel answers 422 to `known_of` in a write body).

## The law (the folder spec §4.4, RULED; `C:/Users/Titus/Carrier/Orrery/product/schema/folder-format-spec.md`, read §4.4 whole). Quoted:

> 1. **A writer writes a stub as it is**: `known_of: true` and only the keys the stub keeps. The unset fields are left out, never written as `""`, `null` or `[]`.
> 2. **A reader treats a `known_of: true` file as known of, never as a whole element**: its absent fields are unknown, not empty.
> 3. **A writer never pushes a stub**: no PUT, PATCH or bulk item is made from a `known_of` file (keel refuses `known_of` in a write body with a 422 anyway).
> 4. **A stub that later arrives whole** (the reader gained another grant) is written whole, and `known_of` goes.
> 5. **A whole element that arrives as a stub** (the reader lost a grant) follows the reset that brought it (keel one-rule §7f): after a `view` reset the stub replaces the whole copy, since what the reader may see narrowed; after a `role` reset, or with no reset, a merge writer keeps the whole copy as last known (the Captain's B12 ruling: a member keeps what they had so far).

Do not hard-code the kept keys: keep every key the stub carries, treat the absent ones as unknown. How the plugin already handles keel's hidden mark (PR 7, `hidden-stub-426`, 3.6.0) is the nearest precedent; read it first and follow its shape.

## What to build (branch `known-of-454`, worktree `C:/wt/plugin-454`)

1. Pull: a `known_of: true` element is written as a note carrying `known_of: true` in its frontmatter and only the stub's keys (rules 1, 4, 5; for rule 5, find how the plugin learns of a `view` or `role` reset today and say in your report what it does with each).
2. Show: the note says plainly that it is known of (a line or callout the way the hidden mark shows, in sentence case, no "Please", no ALL CAPS), so a reader does not take the empty fields for empty.
3. Push: a `known_of` note is never pushed, by any path (single save, bulk push, re-create after a 410). Edits a user makes to it stay local, and the plugin says so once, without nagging.
4. Tests red first for each rule (1 to 5) and for every push path, then green; the whole suite green at the end.

## Rules that bind

- Delete only inside `C:/wt/plugin-454`; any subagent you start carries this line.
- No live writes to any world. Do not release, tag or merge: push the branch, open a PR, stop. The live walk under a player seat is mine or Seethe's after your report.
- One test run at a time; keel's own suite may be running on this machine.

## Report

Your final message, under 3,500 characters: what changed (file by file), the tests (red first, then the counts), what the plugin does on a `view` and a `role` reset, the user-visible lines as they read (for the release card), and anything you found and did not change. Counts last.
