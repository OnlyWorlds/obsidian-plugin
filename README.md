# OnlyWorlds Builder

An Obsidian plugin that keeps an OnlyWorlds world as notes in your vault, one note per element, and syncs it with onlyworlds.com if you want.

Each element is a plain Markdown note. Its number and link fields are Properties; its text fields are foldable sections in the body. Link fields are `[[wikilinks]]`, so relationships show up in the graph view and backlinks. Works on desktop and mobile.

[OnlyWorlds](https://www.onlyworlds.com/about) is an open standard for worldbuilding data: 22 element types (Character, Location, Institution, Event and the rest), each with defined fields and links.

## Install

In Obsidian: **Settings → Community plugins → Browse**, search for **OnlyWorlds Builder**, install and enable it. Or open the [plugin's listing](https://community.obsidian.md/plugins/onlyworlds-builder).

## Start a world

**No account:**

1. Run **Create world** from the command palette (Ctrl/Cmd+P) and choose **Create local-only**.
2. Run **Create element**, pick a type and a name. The note opens with every field that type can carry.
3. Edit it like any note.

A local-only world's `World.md` reads `API Key: local`. Nothing is sent anywhere.

**With an onlyworlds.com account:**

1. Make an account at [onlyworlds.com](https://www.onlyworlds.com/accounts/signup/).
2. Run **Create world** and choose **Create with account** (your email and PIN). The plugin creates the world on onlyworlds.com and writes its API key into `World.md`.
3. Push edits with **Save element**, **Upload world**, or auto-sync (below).

**A world you already have online:** run **Download world** and enter the world's API key (from your [account page](https://www.onlyworlds.com/account/)) and your PIN. A read-only key (`ow_r_`) needs no PIN, which suits a world someone shared with you. Classic 10-digit keys and `ow_` keys both work.

**Taking a local world online:** run **Create world**, enter your email and PIN, pick the world under **Or take a local world online**, and press **Take online**. The plugin creates the world on your account, writes the key into `World.md`, and uploads the elements, keeping their ids and links. (By hand: replace `local` in `World.md` with the key of a world you made on the site, then run **Upload world**.)

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

The body holds one `###` section per text field, in schema order. **Manage fields** adds or removes fields on a note; **Add custom field** adds one of your own (type `Looks`, get a `### Looks` section, synced as `x_looks`). Empty fields are not uploaded.

Text fields round-trip byte for byte through the plugin, spaces, tabs and line endings included, so whitespace you type is a change too: a trailing space or an added blank line goes out with the next save. A line of a value that starts with `### ` is written as `\### ` (Markdown's escape, so the note shows it as typed) and read back without the backslash, so it never starts a new field. A code fence line (```` ``` ```` or `~~~`) that never closes in a value is written as `\~~~` the same way, so a scene break of three tildes comes back as typed. A fence you type open in a note that swallows a later `###` heading is not saved, uploaded or exported, and the notice names the field, the line and that heading; an open fence in the last field swallows nothing and saves.

In a note, a line `\### ` means the text `### `: wherever a line starts with backslashes and then `### ` (or a fence), the plugin reads one backslash off it, so to keep a backslash in the value, type two (`\\### `). When onlyworlds.com already holds the line with that backslash and nothing else differs, Save element and auto-sync keep the server's value; Upload world sends the line as read, without it. Lines inside a closed code block are written and read as typed.

In an element note, fields are read from Properties and `###` sections, and from the old `<span>` lines until **Migrate world notes to frontmatter** converts them. A list you type in an element note's body, as `- height: 172` or `- **Height:** 172`, is description text. The `- **Field:** value` lines are read as fields only in `World.md`, the world's own note.

The note's identity is the `id` in its Properties, so renaming a note does not break anything.

## Sync

The plugin reads the world's key from that world's `World.md`. The **API key** setting is a fallback for a world whose `World.md` has no key (the plugin warns when it uses it). A local-only world never syncs.

Only notes inside a world's `Elements` folders are elements. Notes you already had elsewhere in the vault never sync; to bring one in, run **Create element** and paste its text into the new note.

| How | What it sends |
|---|---|
| **Save element** | The active note. Reads the element on the server first and sends only the fields that changed; fields the note doesn't carry are left alone. No default hotkey: bind one in **Settings → Hotkeys**. |
| **Auto-sync** (off by default) | The note you edited, a few seconds after you stop typing (3000 ms by default, set in settings). Same as Save element. It hears only edits typed in Obsidian: notes another tool writes (Atlas, a script, a sync client) are not pushed, so run Upload world after such a change. |
| **Upload world** | Every element in the active world. It creates new elements and updates existing ones. Elements that exist only on the server are counted in the summary, not deleted. |

On both Save element and Upload world, a link field holding a `[[Name]]` that matches no note in the vault is not sent at all, so the server keeps its copy of that field. Save element names those links; upload the target element, then save again.

When Save element changes an element's name, its note is renamed to match, through Obsidian, so links to it update as your **Files and links** setting says. A name another note already has gets a number, as on download: `Vallaki (1)`. Auto-sync never renames: when it saves a new name, the note keeps its old one until the next Save element renames it, even when nothing else changed. Turn it off in settings.

A link to a note that is in the vault but not on the server yet: Save element lists those elements and asks first (Create or Cancel), then creates them together with the note, and says so ("Created Location "Vallaki" first."). The same goes for that element's own links to new notes. It creates at most 50 this way; past that it creates nothing and asks you to run Upload world. Auto-sync never creates them: the server refuses that save, and the notice says to run Save element.

An element deleted on onlyworlds.com is never brought back without your word, even though Download keeps its note. Save element asks "create it again?", auto-sync refuses, and Upload world asks once for all of them. A link to a deleted element is left out of the save, and the note keeps it.

**Download world** pulls the other way. The first run fetches the whole world; later runs fetch only what changed. For each element that changed on the server, it rewrites that note's fields and body from the server's copy, so unsaved local edits in that note are replaced. Properties the plugin doesn't manage are kept. Elements deleted on the server keep their notes; the plugin tells you how many. An element the world's owner hides from you, or one that leaves your view, keeps its note, but its fields are emptied from it; anything outside them (text above the first field, sections that are not fields) stays, under the line "Hidden by the world's owner.", and Save element and Upload world leave the note out. If the owner shows it to you again, the next Download writes the fields back and keeps what you wrote, above them. To keep your own notes through a hide, write them above the first field: text under a field's heading is part of that field. A hide made before you installed this version leaves your copy of that note as it was.

A player or guest may know of an element without seeing all of it: your Character's sheet names it, and nothing else of yours reaches it. Download writes its note with `known_of: true` in its Properties, only the fields you know, and the line "Known of: you know of this element, not all of it. A field not shown here is unknown, not empty." A known-of note is never sent: Save element and auto-sync say "Known of: this note is not sent. What you write above its fields, or under a ### heading of your own, stays in this vault; its fields follow the next Download. Once the element arrives whole, what you added is part of its note, and Save sends it.", Upload world counts it apart, Delete element moves the note to trash without deleting anything on onlyworlds.com, and Manage fields leaves the note as it is. What you write above its first field, or under a `###` heading of your own, stays through later downloads, and so do Properties of your own; its fields follow the server, and a field the server no longer shows you leaves the note. Text after a field under a `##` or `####` heading is part of that field (only `###` starts a section), so it follows the server too. A link to a known-of element the server no longer serves is left out of a save or an upload. When you come to see the whole element, the next Download writes it in full and the mark goes. Once the element arrives whole, what you added is part of its note, and Save sends it. A note you already held in full stays as you had it, and is not sent while the server serves only the known-of view, unless the server tells this device your view narrowed; then the known-of note replaces it.

**World units.** `World.md` has a Units section: Length Unit, Mass Unit and Distance Unit, free text such as `cm`, `kg` or `leagues`. They are labels only; nothing converts. Properties shows the unit beside the nine numbers that use one: height and weight on Characters and Creatures, Creature speed, weight on Objects and Species, Ability range and Location elevation. Download world writes the server's units into `World.md`. Upload world sends them when you changed them; only the world's owner can.

The ribbon icon and the desktop status bar show the sync state: idle, dirty, syncing, synced or error.

## Bases

Download world and Create world write `<World name>.base` beside `World.md`: a table and a card view for each element type in Obsidian's core Bases plugin (Obsidian 1.9 or later). Turn it off with the **Write a Bases file per world** setting.

The plugin rewrites only its own file, unchanged since it wrote it. Once you change the base (a view, a sort, a column), Download leaves it as is and says so once; delete it, or run **Write Bases file**, which rebuilds it and keeps your version beside it as `<World name> (your copy).base`. Rename world moves the plugin's file to the new name.

With Obsidian Sync or another sync tool, Download rebuilds the base from your world on each device. A stale copy from another device then replaces the base, unless it carries your edits: a base with your edits is kept as is, and Write Bases file saves it as `<World name> (your copy).base` before it rebuilds. Let an edited base sync to every device before you download on another.

## Commands

| Command | What it does |
|---|---|
| Create world | Create a world: with an account, local-only, or take a local world online. |
| Download world | Pull a world from onlyworlds.com into the vault. Later runs fetch only changes. |
| Create element | New note with a fresh id and the type's full field set. |
| Save element | Push the active note (see Sync). |
| Upload world | Push every element in the active world: create and update, never delete. |
| Delete element (server + note) | Delete the element from onlyworlds.com and move the note to the trash, after you type its name. In a local-only world it only trashes the note. |
| Link elements | Pick a link field, then a target element; writes a `[[wikilink]]`. You can also type in the Property directly. |
| Manage fields | Tick which fields the note carries. A field with content can't be removed here: clear it first. |
| Add custom field | Add your own text field (stored as `x_<name>`). |
| Rename world | Rename the world folder, and the world on onlyworlds.com if it has a key. |
| Write Bases file | Write the active world's `.base` file (see Bases); rebuilds one you changed, keeping your version beside it. |
| Draw relationships on a canvas | Draw the active element, what it links to and what links to it as an Obsidian canvas beside its note, each arrow labelled with its field. A Relation keeps its own card. Running it again redraws the canvas; one you changed is first saved as `(your copy)`. File names stop at 255 characters, so an element whose name is longer than about 230 gets no canvas. |
| Export as OnlyWorlds folder | Write the world as an OnlyWorlds folder (`world.json` plus one JSON file per element). Into the vault, or on desktop into any folder, such as your [Atlas](https://atlas.onlyworlds.com) folder. Never overwrites an existing folder. |
| Import OnlyWorlds folder | Read an OnlyWorlds folder placed in the vault into notes. Skips elements that already have a note; refuses to merge into a different world of the same name. |
| Copy world to clipboard / Paste world from clipboard | The world as JSON, out and back in. |
| Update world to latest format | Bring older notes to the current layout: adds missing fields, moves text fields into body sections. Shows the changes and writes nothing until you confirm. |
| Migrate world notes to frontmatter | Convert notes from the old `<span>` format. Backs every note up first, to `OW-backup-<world>-<timestamp>/`. |
| Validate world | Check old `<span>`-format notes for malformed fields. Notes in the current format are skipped. |

Updating the plugin does not change your notes, and it reads every format it has written. Run either format command on a copy of the vault the first time.

## Settings

| Setting | Default | What it does |
|---|---|---|
| API key | empty | Fallback key for a world whose `World.md` has none. Stored in the vault's plugin data. |
| API PIN | empty | Your 4-digit PIN, stored in the vault's plugin data. Leave empty to be asked once per session. |
| Default world | empty | The world commands act on. Empty: the first world alphabetically. |
| Default email | empty | Pre-fills the email in Create world. |
| Default new element category | Character | Pre-selected in Create element. |
| Individual element creation commands | off | Adds a `Create new <Type>` command per element type. Reload Obsidian after changing it. |
| Auto-sync to OnlyWorlds | off | Push edits automatically. |
| Auto-sync debounce (ms) | 3000 | Wait after the last edit before pushing (250 to 30000). |
| Show status bar indicator | on | Sync state in the desktop status bar. |
| Rename note when the element's name changes | on | After Save element changes an element's name, rename its note to match. Auto-sync never renames. |
| Write a Bases file per world | on | Download world and Create world write the world's `.base` file (see Bases). |
| Relationship canvas: links to the element | on | Draw relationships on a canvas also draws the elements that link to the active one. |

## Files

```
OnlyWorlds/
├── README.md
├── Settings.md
└── Worlds/<World name>/
    ├── World.md
    ├── <World name>.base
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
