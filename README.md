# OnlyWorlds Builder — Obsidian Plugin

Obsidian plugin for building and syncing with OnlyWorlds.

## What is OnlyWorlds

[OnlyWorlds](https://www.onlyworlds.com/about) is an open data standard for worldbuilding. A world is made of elements across 22 categories, each with defined fields and link relationships. Worlds can live entirely in a local vault, and can be uploaded to [onlyworlds.com](https://www.onlyworlds.com/worlds), where a free account hosts your worlds and exposes them via REST API so that other tools can read and write it. The standard is open source and the tools and platform are free.

## What this plugin does

Manages OnlyWorlds elements as Obsidian notes: one note per element, organized into folders per category, inside an `OnlyWorlds/` folder in a vault. Notes are plain markdown, editable like any other.

Optional: connect the plugin to an onlyworlds.com account, and edits can be pushed to the cloud on demand or automatically. That makes the same world available to other OnlyWorlds tools and accessible via the API.

## Getting started

Local-only setup:

1. Install the plugin from Community Plugins.
2. Run **Create World** from the command palette (Ctrl/Cmd+P). The plugin creates the `OnlyWorlds/` folder structure in your vault.
3. Use `Create Element` to add elements. Edit them like any Obsidian note.

If you already have a world on onlyworlds.com, run **Import World** instead of step 2 to set up the folder structure and pull your existing elements into the vault.

To also sync with onlyworlds.com:

4. Create a free account at [onlyworlds.com](https://www.onlyworlds.com).
5. In Obsidian, open **Settings → OnlyWorlds**. Paste your active world's API key, and PIN from your profile.
6. Push to web with auto-sync or the `Save Element` command (see below).

## How sync works

Three ways to push edits to onlyworlds.com:

**Export World.** Push every element in the active world in one go. A full overwrite of the cloud world from your local copy.

**Save Element.** Run the command on the active note to push that single element. Bind a hotkey if you'll use it often (Settings → Hotkeys, search "Save Element", set something like Ctrl/Cmd+Shift+S).

**Auto-sync.** Toggle on in plugin settings. After 3 seconds of inactivity following an edit, the plugin pushes the changed element via the OnlyWorlds API. 

The ribbon icon and desktop status bar reflect the current state: `idle`, `dirty` (unsaved local changes), `syncing`, `synced`, or `error`. 

You can set your PIN once in settings so the plugin never asks again.  

## Authentication

The plugin talks to the OnlyWorlds REST API at `https://www.onlyworlds.com/api/worldapi/`. Each API call sends your API-Key and API-Pin as headers, scoped to one world. Your API key identifies which world you're touching, and your PIN authorizes writes. Both stay local. They live in your vault's plugin settings (`data.json`).

## Folder structure

The plugin creates and manages:

```
OnlyWorlds/
├── Worlds/<World name>/
│   ├── World.md
│   └── Elements/<Category>/<element>.md
└── PluginFiles/   (templates, managed automatically)
```
 

## Commands

| Command | What it does |
|---|---|
| `Create World` | Create a new world (account-linked) and the local folder structure. |
| `Import World` | Pull all elements of an existing world from onlyworlds.com into your vault. |
| `Create Element` | Pick a category and name. Generates a new note with a fresh UUID. |
| `Save Element` | Push the active element note to the API. Bind a hotkey via Settings → Hotkeys. |
| `Export World` | Bulk push every element in the active world. |
| `Validate World` | Check element notes for malformed fields. |
| `Rename World` | Rename a world folder safely. |
| `Link Elements` | With your cursor in a link field, pick a target element to insert. |
| `Copy World to Clipboard` | Serialize the active world as JSON and copy to clipboard. |
| `Paste World from Clipboard` | Build a world from JSON in clipboard. |

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

## Get in touch
 
- [discord](https://discord.gg/twCjqvVBwb)
- [council](https://council.onlyworlds.com)
- info@onlyworlds.com
