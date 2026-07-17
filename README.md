# OnlyWorlds Builder — Obsidian Plugin

Obsidian plugin for building and syncing with OnlyWorlds.

## What is OnlyWorlds

[OnlyWorlds](https://www.onlyworlds.com/about) is an open data standard for worldbuilding. A world is made of elements across 22 categories, each with defined fields and link relationships. Worlds can live entirely in a local vault, and can be uploaded to [onlyworlds.com](https://www.onlyworlds.com), where a free account hosts your worlds and exposes them via REST API so that other tools can read and write it. The standard is open source and the tools and platform are free.

## What this plugin does

Manages OnlyWorlds elements as Obsidian notes: one note per element, organized into folders per category, inside an `OnlyWorlds/` folder in a vault. Notes are plain markdown, editable like any other. Since 3.0.0 each element's fields live in the note's Properties (YAML frontmatter), and link fields are clickable `[[wikilinks]]` — so relationships show up in Obsidian's graph and backlinks, and the note reads as prose with structured data attached.

Optional: connect the plugin to an onlyworlds.com account, and edits can be pushed to the cloud on demand or automatically. That makes the same world available to other OnlyWorlds tools and accessible via the API.

## Getting started

Local-only setup:

1. Install the plugin from Community Plugins.
2. Run **Create World** from the command palette (Ctrl/Cmd+P). The plugin creates the `OnlyWorlds/` folder structure in your vault.
3. Use `Create Element` to add elements. Edit them like any Obsidian note.

If you already have a world on onlyworlds.com, run **Download World** instead of step 2: enter the world's API key (a classic 10-digit key or an `ow_` key from your account page) and your PIN, and the plugin sets up the folder structure and pulls your existing elements into the vault. A **read-only key** (`ow_r_`) needs no PIN — handy for opening a world someone shared with you. You can also just set your key in **Settings → OnlyWorlds** to sync on demand.

To also sync with onlyworlds.com:

4. Create a free account at [onlyworlds.com](https://www.onlyworlds.com).
5. In Obsidian, open **Settings → OnlyWorlds**. Paste your world's API key — shown on your world's page under [Account](https://www.onlyworlds.com/account/) — and your 4-digit PIN. Classic 10-digit keys and newer `ow_`-prefixed keys both work.
6. Push to web with auto-sync or the `Save Element` command (see below).

## How sync works

Three ways to push edits to onlyworlds.com:

**Upload World.** Push every element in the active world in one go. Since 2.3.0 this is a safe sweep, not an overwrite: new elements are created, existing ones updated, and elements that exist only on the server are reported — never deleted. Link fields that can't be resolved locally are skipped so cloud links are never silently stripped.

**Save Element.** Run the command on the active note to push that single element. Bind a hotkey if you'll use it often (Settings → Hotkeys, search "Save Element", set something like Ctrl/Cmd+Shift+S).

**Auto-sync.** Toggle on in plugin settings. After 3 seconds of inactivity following an edit, the plugin pushes the changed element via the OnlyWorlds API. 

The ribbon icon and desktop status bar reflect the current state: `idle`, `dirty` (unsaved local changes), `syncing`, `synced`, or `error`. 

You can set your PIN once in settings so the plugin never asks again.

## Note format and migrating from an older version

Since 3.0.0 elements are stored as **YAML frontmatter** (fields in the Properties panel) with link fields as clickable `[[Name]]` wikilinks. Earlier versions stored fields as inline `<span>` lines in the note body.

Updating the plugin does **not** change your existing notes. The new version reads both formats, so an old vault keeps working — sync, save, and download all function on span-format notes. When you want the new readable format, run **Migrate world notes to frontmatter** from the command palette. It backs up every note first (into `OW-backup-<world>-<timestamp>/`), aborts if the backup fails, and is safe to run twice (already-migrated notes are skipped). The backup folder is your undo. Run it on a copy of a vault you care about the first time.

Downloading a world always writes the new frontmatter format.

## Authentication

The plugin talks to the OnlyWorlds v2 REST API at `https://www.onlyworlds.com/api/v2/` (since 2.3.0). Each API call sends your API-Key and API-Pin as headers, scoped to one world. Your API key identifies which world you're touching, and your PIN authorizes writes. Both stay local. They live in your vault's plugin settings (`data.json`).

## Folder structure

The plugin creates and manages:

```
OnlyWorlds/
├── Worlds/<World name>/
│   ├── World.md
│   └── Elements/<Category>/<element>.md
└── PluginFiles/   (managed automatically)
```

The filename is presentation; the element's identity is the `id` in its frontmatter, so renaming a note is safe.
 

## Commands

| Command | What it does |
|---|---|
| `Create World` | Create a new world (account-linked) and the local folder structure. |
| `Download World` | Pull a world from onlyworlds.com into your vault (10-digit and `ow_` keys). Incremental since 2.3.0: re-downloads fetch only what changed. |
| `Create Element` | Pick a category and name. Generates a new note with a fresh UUID. |
| `Save Element` | Push the active element note to the API. Reads current server state first and sends only what changed. Bind a hotkey via Settings → Hotkeys. |
| `Upload World` | Bulk push every element in the active world (create + update, never delete). |
| `Delete Element (server + note)` | Permanently delete the active note's element from onlyworlds.com and trash the note. Type-the-name confirmation. |
| `Migrate world notes to frontmatter` | Convert a world's notes from the legacy `<span>` format to frontmatter. Backs up first; idempotent. See *Note format* above. |
| `Export as OnlyWorlds folder` | Write the active world as a portable OnlyWorlds folder (`world.json` + per-element JSON). Choose the vault or any folder — point it at your Atlas root to open the world in [Atlas](https://atlas.onlyworlds.com) directly. |
| `Import OnlyWorlds folder` | Read an OnlyWorlds folder (from Atlas or any tool) placed in your vault into frontmatter notes. Never overwrites existing notes; never merges two different worlds. |
| `Validate World` | Check legacy `<span>`-format notes for malformed fields. (Frontmatter notes are skipped — a frontmatter-aware check is planned.) |
| `Rename World` | Rename a world folder, and sync the new name to onlyworlds.com if the world has a write key. |
| `Link Elements` | Pick a link field (empty fields shown first, single links on top), then a target element by name; the plugin writes it as a clickable `[[wikilink]]`. You can also just edit a link Property directly — Obsidian autocompletes note names natively. |
| `Copy World to Clipboard` | Serialize the active world as JSON and copy to clipboard. |
| `Paste World from Clipboard` | Build a world from JSON in clipboard (writes frontmatter notes; round-trips with Copy). |

## Settings

| Setting | Default | What it does |
|---|---|---|
| API key | empty | Your OnlyWorlds API key. Stored locally. |
| API PIN | empty | Your 4-digit PIN. Stored locally. Empty means you'll be prompted once per session. |
| Default world | empty | The active world. Falls back to the alphabetically first under `OnlyWorlds/Worlds/`. |
| Default email | empty | Pre-fills email when creating worlds. |
| Default new element category | Character | Pre-selected in `Create Element`. |
| Individual element creation commands | off | Adds `Create new <Category>` commands for each of the 22 categories. Reload Obsidian after toggling. |
| Auto-sync to OnlyWorlds | off | Push edits automatically after idle period. |
| Auto-sync debounce | 3000ms | How long to wait after last edit. |
| Show status bar indicator | on | Desktop status bar icon. |

## Part of the OnlyWorlds ecosystem

Your world is not locked to this plugin — the same world, synced to onlyworlds.com, is readable and writable by every OnlyWorlds tool:

| Surface | What it is |
|---|---|
| [onlyworlds.com](https://www.onlyworlds.com) | The platform: hosts worlds, serves the API, account & key management at [/account](https://www.onlyworlds.com/account/). |
| [Atlas](https://atlas.onlyworlds.com) | Local-first world browser, editor and writing tool — your world as a folder of plain JSON files, with maps, charts and publishing. |
| [Shared pages](https://show.onlyworlds.com) | Public, frozen pages of your elements, minted from Atlas. |
| MCP server | Connect Claude (Code, Desktop, or API) directly to your world at `https://www.onlyworlds.com/mcp` — schema questions need no key at all. |
| [API docs](https://onlyworlds.github.io) | Full API reference, error catalog, and guides for building your own tools. |

A vault and an Atlas folder can hold the same world, two ways. Through the **cloud**: both sync against onlyworlds.com, so edits flow between them via the API (point both at the same world key and take turns — live co-editing of one folder is not a thing). Or through a **folder**, no account needed: `Export as OnlyWorlds folder` writes a portable OnlyWorlds folder you can open straight in Atlas, and `Import OnlyWorlds folder` reads one back in. The OnlyWorlds folder is an open format — filename is presentation, `id` is identity — so any tool that speaks it can hand a world to any other.

## Get in touch 

- [github](https://github.com/OnlyWorlds)
- [discord](https://discord.gg/twCjqvVBwb)
- [council](https://council.onlyworlds.com)
- [email](info@onlyworlds.com)
