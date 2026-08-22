# OnlyWorlds Builder — Obsidian Plugin

Obsidian plugin for building and syncing with OnlyWorlds.

## What is OnlyWorlds

[OnlyWorlds](https://www.onlyworlds.com/about) is an open data standard for worldbuilding. A world is made of elements across 22 categories, each with defined fields and link relationships. Worlds can live entirely in a local vault, and can be uploaded to [onlyworlds.com](https://www.onlyworlds.com), where a free account hosts your worlds and exposes them via REST API so that other tools can read and write it. The standard is open source and the tools and platform are free.

## What this plugin does

Manages OnlyWorlds elements as Obsidian notes: one note per element, in folders per category, inside an `OnlyWorlds/` folder. Notes are plain markdown, editable like any other.

An element's structured fields live in the note's Properties, its text fields as foldable sections in the body. Link fields are clickable `[[wikilinks]]`, so relationships show up in Obsidian's graph and backlinks.

Optional: connect the plugin to an onlyworlds.com account, and edits can be pushed to the cloud on demand or automatically. That makes the same world available to other OnlyWorlds tools and accessible via the API.

## Getting started

Local-only setup, no account needed:

1. Install the plugin from Community Plugins.
2. Run **Create World** from the command palette (Ctrl/Cmd+P) and choose **Create local-only**. The plugin creates the `OnlyWorlds/` folder structure in your vault; nothing leaves your disk.
3. Use `Create Element` to add elements. Edit them like any Obsidian note.

A local-only world's `World.md` shows `API Key: local`. Everything stays on your disk until you decide otherwise.

To sync with onlyworlds.com instead:

1. Create a free account at [onlyworlds.com](https://www.onlyworlds.com).
2. Open **Settings → OnlyWorlds** and paste your world's API key (shown on your world's page under [Account](https://www.onlyworlds.com/account/)) and your 4-digit PIN. Classic 10-digit keys and newer `ow_`-prefixed keys both work.
3. Push with auto-sync or the `Save Element` command.

Already have a world on onlyworlds.com? Run **Download World** and the plugin builds the folder structure and pulls your elements in. A read-only key (`ow_r_`) needs no PIN, handy for opening a world someone shared with you.

## How sync works

Three ways to push edits to onlyworlds.com:

**Upload World.** Push every element in the active world in one go. It is a safe sweep, not an overwrite: new elements are created, existing ones updated, and elements that exist only on the server are reported, never deleted. If a link points to an element that isn't in your vault, that whole link field is left untouched on the server rather than sent short, so cloud links are never silently stripped.

**Save Element.** Run the command on the active note to push that single element. Bind a hotkey if you'll use it often (Settings → Hotkeys, search "Save Element", set something like Ctrl/Cmd+Shift+S).

**Auto-sync.** Toggle on in plugin settings. After 3 seconds of inactivity following an edit, the plugin pushes the changed element via the OnlyWorlds API.

The ribbon icon and desktop status bar reflect the current state: `idle`, `dirty` (unsaved local changes), `syncing`, `synced`, or `error`.

You can set your PIN once in settings so the plugin never asks again.

**Taking a local-only world online.** Two ways:

- Run **Create World**, enter your account email and PIN, pick the world under *"Or take a local world online"*, and hit **Take online**. The plugin creates the world under your account, links your vault's copy to it, and uploads your elements. One flow, no site visit needed.
- Or do it by hand: create a world at [onlyworlds.com](https://www.onlyworlds.com), copy its API key, replace the word `local` in the world's `World.md` API Key line, and run **Upload World**.

Either way the world keeps its element IDs and links, and from then on it syncs like any other world.

## Note format and migrating from an older version

An element note has two halves, and which half a field lives in depends on what kind of field it is:

```markdown
---
name: Zelraun Roaringhorn
id: 069f869b-de7a-7466-8000-eeea6e0e5632
supertype: noble
height: 182
charisma: 62
species: [[Human]]
location: [[Waterdeep]]
---

### Description

A knight of Barovia.

### Physicality

Tall and weathered, moves like someone expecting a fight.
```

**Properties** hold the element's identity (name, id, supertype, subtype, image), then its number fields, then its link fields.

**The body** holds the text fields, one heading per field, in schema order. Headings fold, so a long element collapses to an outline.

A new element is created with every field it can carry, empty ones included. `Manage Fields` adds and removes them per note; `Add Custom Field` makes one of your own, stored as `x_yourfield` (how the OnlyWorlds standard carries custom field).

Empty fields are not uploaded.  

### Coming from an older version

Updating the plugin does **not** change your existing notes, and nothing is deleted. The plugin reads every format it has ever written, so an old vault keeps syncing untouched.

To bring a world up to the current layout, run **Update World to Latest Format**. It shows you what it would change before touching anything, moves text fields into body sections, adds whatever fields are missing, and is safe to run twice. Notes whose body already contains headings that clash with field names are listed and left alone for you to look at, rather than guessed at. For the older `<span>` format there is also **Migrate world notes to frontmatter**, which backs every note up first (into `OW-backup-<world>-<timestamp>/`) and aborts if the backup fails.

Run either on a copy of a vault you care about the first time.

## Authentication

The plugin talks to the OnlyWorlds v2 REST API at `https://www.onlyworlds.com/api/v2/`. Each API call sends your API-Key and API-Pin as headers, scoped to one world. Your API key identifies which world you're touching, and your PIN authorizes writes. Both stay local. They live in your vault's plugin settings (`data.json`).

## Folder structure

The plugin creates and manages:

```
OnlyWorlds/
├── Worlds/<World name>/
│   ├── World.md
│   └── Elements/<Category>/<element>.md
└── PluginFiles/   (a README + settings note)
```

The filename is presentation; the element's identity is the `id` in its frontmatter, so renaming a note is safe.


## Commands

| Command                              | What it does                                                                                                                                                                                                                                  |
|--------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `Create World`                       | Create a new world and the local folder structure. Three paths: account-linked, **local-only** (no account, nothing leaves your vault), or **Take online** (publish an existing local-only world to your account and upload its elements).    |
| `Download World`                     | Pull a world from onlyworlds.com into your vault. Incremental: re-downloads fetch only what changed.                                                                                                                                          |
| `Create Element`                     | Pick a category and name. Generates a note with a fresh UUID and the category's full field set: properties for numbers and links, empty sections for text fields.                                                                             |
| `Save Element`                       | Push the active element note to the API. Reads current server state first and sends only what changed. Bind a hotkey via Settings → Hotkeys.                                                                                                  |
| `Upload World`                       | Bulk push every element in the active world (create + update, never delete).                                                                                                                                                                  |
| `Delete Element (server + note)`     | Permanently delete the active note's element from onlyworlds.com and trash the note. Type-the-name confirmation. In a local-only world, just trashes the note.                                                                                |
| `Migrate world notes to frontmatter` | Convert a world's notes from the legacy `<span>` format to frontmatter. Backs up first; idempotent. See *Note format* above.                                                                                                                  |
| `Export as OnlyWorlds folder`        | Write the active world as a portable OnlyWorlds folder (`world.json` + per-element JSON). Point it at your Atlas root to open the world in [Atlas](https://atlas.onlyworlds.com) directly.                                                    |
| `Import OnlyWorlds folder`           | Read an OnlyWorlds folder (from Atlas or any tool) placed in your vault into frontmatter notes. Never overwrites existing notes; never merges two different worlds.                                                                           |
| `Validate World`                     | Check legacy `<span>`-format notes for malformed fields. (Frontmatter notes are skipped; a frontmatter-aware check is planned.)                                                                                                               |
| `Rename World`                       | Rename a world folder, and sync the new name to onlyworlds.com if the world has a write key.                                                                                                                                                  |
| `Link Elements`                      | Pick a link field (empty fields shown first, single links on top), then a target element by name; the plugin writes it as a clickable `[[wikilink]]`. You can also edit a link Property directly; Obsidian autocompletes note names natively. |
| `Manage Fields`                      | Tick which fields this element carries, grouped as text, custom, numbers and links. Changes apply as you toggle. A field holding content can't be removed here: clear it in the note first, so a tickbox never deletes your writing.          |
| `Add Custom Field`                   | Add a text field of your own to the active note. Type `Looks`, get a `### Looks` section; it syncs as `x_looks`.                                                                                                                              |
| `Update World to Latest Format`      | Bring a world's notes up to the current layout: adds missing fields, moves text fields into body sections. Shows what it would change first and writes nothing until you confirm. Safe to run twice.                                          |
| `Copy World to Clipboard`            | Serialize the active world as JSON and copy to clipboard.                                                                                                                                                                                     |
| `Paste World from Clipboard`         | Build a world from JSON in clipboard (writes frontmatter notes; round-trips with Copy).                                                                                                                                                       |

## Settings

| Setting                              | Default   | What it does                                                                                         |
|--------------------------------------|-----------|------------------------------------------------------------------------------------------------------|
| API key                              | empty     | Your OnlyWorlds API key. Stored locally.                                                             |
| API PIN                              | empty     | Your 4-digit PIN. Stored locally. Empty means you'll be prompted once per session.                   |
| Default world                        | empty     | The active world. Falls back to the alphabetically first under `OnlyWorlds/Worlds/`.                 |
| Default email                        | empty     | Pre-fills email when creating worlds.                                                                |
| Default new element category         | Character | Pre-selected in `Create Element`.                                                                    |
| Individual element creation commands | off       | Adds `Create new <Category>` commands for each of the 22 categories. Reload Obsidian after toggling. |
| Auto-sync to OnlyWorlds              | off       | Push edits automatically after idle period.                                                          |
| Auto-sync debounce                   | 3000ms    | How long to wait after last edit.                                                                    |
| Show status bar indicator            | on        | Desktop status bar icon.                                                                             |

## Part of the OnlyWorlds ecosystem

Your world is not locked to this plugin. Synced to onlyworlds.com, it is readable and writable by every OnlyWorlds tool:

| Surface                                      | What it is                                                                                                                              |
|----------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| [onlyworlds.com](https://www.onlyworlds.com) | The platform: hosts worlds, serves the API, account & key management at [/account](https://www.onlyworlds.com/account/).                |
| [Atlas](https://atlas.onlyworlds.com)        | Local-first world browser, editor and writing tool. Your world as a folder of plain JSON files, with maps, charts and publishing.       |
| [Shared pages](https://show.onlyworlds.com)  | Public, frozen pages of your elements, minted from Atlas.                                                                               |
| MCP server                                   | Connect Claude (Code, Desktop, or API) directly to your world at `https://www.onlyworlds.com/mcp`. Schema questions need no key at all. |
| [API docs](https://onlyworlds.github.io)     | Full API reference, error catalog, and guides for building your own tools.                                                              |

A vault and an Atlas folder can hold the same world, two ways. Through the **cloud**: both sync against onlyworlds.com, so edits flow between them via the API (point both at the same world key and take turns; live co-editing of one folder is not a thing). Or through a **folder**, no account needed: `Export as OnlyWorlds folder` writes a portable OnlyWorlds folder you can open straight in Atlas, and `Import OnlyWorlds folder` reads one back in. The OnlyWorlds folder is an open format (filename is presentation, `id` is identity), so any tool that speaks it can hand a world to any other.

## Get in touch

- [github](https://github.com/OnlyWorlds)
- [discord](https://discord.gg/twCjqvVBwb)
- [council](https://council.onlyworlds.com)
- [email](info@onlyworlds.com)
