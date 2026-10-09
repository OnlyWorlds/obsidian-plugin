# OnlyWorlds Builder

An Obsidian plugin that keeps an OnlyWorlds world as notes in your vault, one note per element, and syncs it with onlyworlds.com if you want.

Each element is a plain Markdown note. Its number and link fields are Properties; its text fields are foldable sections in the body. Link fields are `[[wikilinks]]`, so relationships show up in the graph view and backlinks. Works on desktop and mobile.

[OnlyWorlds](https://www.onlyworlds.com/about) is an open standard for worldbuilding data: 22 element types (Character, Location, Institution, Event and the rest), each with defined fields and links.

## Install

In Obsidian: **Settings → Community plugins → Browse**, search for **OnlyWorlds Builder**, install and enable it. Or open the [plugin's listing](https://community.obsidian.md/plugins/onlyworlds-builder).

## Start a world

**No account:**

1. Run **Create World** from the command palette (Ctrl/Cmd+P) and choose **Create local-only**.
2. Run **Create Element**, pick a type and a name. The note opens with every field that type can carry.
3. Edit it like any note.

A local-only world's `World.md` reads `API Key: local`. Nothing is sent anywhere.

**With an onlyworlds.com account:**

1. Make an account at [onlyworlds.com](https://www.onlyworlds.com/accounts/signup/).
2. Run **Create World** and choose **Create with account** (your email and PIN). The plugin creates the world on onlyworlds.com and writes its API key into `World.md`.
3. Push edits with **Save Element**, **Upload World**, or auto-sync (below).

**A world you already have online:** run **Download World** and enter the world's API key (from your [account page](https://www.onlyworlds.com/account/)) and your PIN. A read-only key (`ow_r_`) needs no PIN, which suits a world someone shared with you. Classic 10-digit keys and `ow_` keys both work.

**Taking a local world online:** run **Create World**, enter your email and PIN, pick the world under **Or take a local world online**, and press **Take online**. The plugin creates the world on your account, writes the key into `World.md`, and uploads the elements, keeping their ids and links. (By hand: replace `local` in `World.md` with the key of a world you made on the site, then run **Upload World**.)

## A note

```markdown
---
id: 069f869b-de7a-7466-8000-eeea6e0e5632
name: Maren Vell
supertype: pilot
height: 172
charisma: 62
species:
  - "[[Human]]"
location: "[[Gullwrack]]"
---

### Description

Harbour pilot of Gullwrack, forty years on the shoals.

### Physicality

Weathered, quick hands, a limp she never explains.
```

The body holds one `###` section per text field, in schema order. **Manage Fields** adds or removes fields on a note; **Add Custom Field** adds one of your own (type `Looks`, get a `### Looks` section, synced as `x_looks`). Empty fields are not uploaded.

The note's identity is the `id` in its Properties, so renaming a note does not break anything.

## Sync

The plugin reads the world's key from that world's `World.md`. The **API key** setting is a fallback for a world whose `World.md` has no key (the plugin warns when it uses it). A local-only world never syncs.

| How | What it sends |
|---|---|
| **Save Element** | The active note. Reads the element on the server first and sends only the fields that changed; fields the note doesn't carry are left alone. No default hotkey: bind one in **Settings → Hotkeys**. |
| **Auto-sync** (off by default) | The note you edited, a few seconds after you stop typing (3000 ms by default, set in settings). Same as Save Element. |
| **Upload World** | Every element in the active world. It creates new elements and updates existing ones. Elements that exist only on the server are counted in the summary, not deleted. |

On both Save Element and Upload World, a link field holding a `[[Name]]` that matches no note in the vault is not sent at all, so the server keeps its copy of that field. Save Element names those links; upload the target element, then save again.

**Download World** pulls the other way. The first run fetches the whole world; later runs fetch only what changed. For each element that changed on the server, it rewrites that note's fields and body from the server's copy, so unsaved local edits in that note are replaced. Properties the plugin doesn't manage are kept. Elements deleted on the server keep their notes; the plugin tells you how many.

The ribbon icon and the desktop status bar show the sync state: idle, dirty, syncing, synced or error.

## Commands

| Command | What it does |
|---|---|
| Create World | Create a world: with an account, local-only, or take a local world online. |
| Download World | Pull a world from onlyworlds.com into the vault. Later runs fetch only changes. |
| Create Element | New note with a fresh id and the type's full field set. |
| Save Element | Push the active note (see Sync). |
| Upload World | Push every element in the active world: create and update, never delete. |
| Delete Element (server + note) | Delete the element from onlyworlds.com and move the note to the trash, after you type its name. In a local-only world it only trashes the note. |
| Link Elements | Pick a link field, then a target element; writes a `[[wikilink]]`. You can also type in the Property directly. |
| Manage Fields | Tick which fields the note carries. A field with content can't be removed here: clear it first. |
| Add Custom Field | Add your own text field (stored as `x_<name>`). |
| Rename World | Rename the world folder, and the world on onlyworlds.com if it has a key. |
| Export as OnlyWorlds folder | Write the world as an OnlyWorlds folder (`world.json` plus one JSON file per element). Into the vault, or on desktop into any folder, such as your [Atlas](https://atlas.onlyworlds.com) folder. Never overwrites an existing folder. |
| Import OnlyWorlds folder | Read an OnlyWorlds folder placed in the vault into notes. Skips elements that already have a note; refuses to merge into a different world of the same name. |
| Copy World to Clipboard / Paste World from Clipboard | The world as JSON, out and back in. |
| Update World to Latest Format | Bring older notes to the current layout: adds missing fields, moves text fields into body sections. Shows the changes and writes nothing until you confirm. |
| Migrate world notes to frontmatter | Convert notes from the old `<span>` format. Backs every note up first, to `OW-backup-<world>-<timestamp>/`. |
| Validate World | Check old `<span>`-format notes for malformed fields. Notes in the current format are skipped. |

Updating the plugin does not change your notes, and it reads every format it has written. Run either format command on a copy of the vault the first time.

## Settings

| Setting | Default | What it does |
|---|---|---|
| API key | empty | Fallback key for a world whose `World.md` has none. Stored in the vault's plugin data. |
| API PIN | empty | Your 4-digit PIN, stored in the vault's plugin data. Leave empty to be asked once per session. |
| Default world | empty | The world commands act on. Empty: the first world alphabetically. |
| Default email | empty | Pre-fills the email in Create World. |
| Default new element category | Character | Pre-selected in Create Element. |
| Individual element creation commands | off | Adds a `Create new <Type>` command per element type. Reload Obsidian after changing it. |
| Auto-sync to OnlyWorlds | off | Push edits automatically. |
| Auto-sync debounce (ms) | 3000 | Wait after the last edit before pushing (250 to 30000). |
| Show status bar indicator | on | Sync state in the desktop status bar. |

## Files

```
OnlyWorlds/
├── README.md
├── Settings.md
└── Worlds/<World name>/
    ├── World.md
    └── Elements/<Type> (<count>)/<Element name>.md
```

The plugin talks to the OnlyWorlds API at `https://www.onlyworlds.com/api/v2/`, sending the world's key and your PIN as headers.

## Links

- [Docs](https://onlyworlds.github.io)
- [The OnlyWorlds schema](https://github.com/OnlyWorlds/OnlyWorlds)
- [Atlas](https://atlas.onlyworlds.com), which opens the same world as a folder
- [Discord](https://discord.gg/twCjqvVBwb) · [Council](https://council.onlyworlds.com) · [info@onlyworlds.com](mailto:info@onlyworlds.com)
- Issues: [github.com/OnlyWorlds/obsidian-plugin](https://github.com/OnlyWorlds/obsidian-plugin/issues)

## Licence

MIT. See [LICENSE](https://github.com/OnlyWorlds/obsidian-plugin/blob/main/LICENSE).
