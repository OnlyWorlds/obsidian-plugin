/**
 * The old Settings note, retired (ruled 2026-11-03). The note's values move into the settings once; the plugin's own
 * note becomes a pointer WITH its old text kept beneath it; a note that is the user's own text is read and never
 * touched; no note is not marked done (a sync may deliver it later). The cold read of this change (11-03) found the
 * first version replaced a whole note when the user had added to it, and left other devices with no values: both
 * are tests here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MOVED_MARK,
	NOTE_HEADER,
	SETTINGS_NOTE_PATH,
	applyNoteValues,
	holdsValues,
	isMovedNote,
	isPluginTemplateNote,
	migrateSettingsNote,
	movedNoteText,
	parseSettingsNote,
	type NoteStore,
} from "../settings/settings-note";

const CATS = ["Character", "Location", "Object"];
const DEFAULTS = { defaultWorld: "", defaultCategory: "Character", individualElementCommands: false };

// The plugin's own template as 3.17.0 wrote it, with the values a user would have typed.
const template = (world: string, ind: string, cat: string) => `# OnlyWorlds Plugin Settings

- **Primary World Name:** ${world}
*Specify the name of the world you are actively working on.
Affects: 1. element creation commands, 2. copy world command, 3. manual validation command.
When empty, defaults to top-in-hierarchy under OnlyWorlds/Worlds/*

- **Individual Element Creation Commands:** ${ind}
*Change to 'Yes' to allow a separate creation command for each element category.
Reload Obsidian to register change.*


- **Default New Element Category:** ${cat}
*Determines which category is pre-filled when the Create Element command is executed.
Reload Obsidian to register change.*
`;

function store(files: Record<string, string>, opts: { failRead?: boolean; failWrite?: boolean; failExists?: boolean } = {}) {
	const writes: string[] = [];
	const s: NoteStore = {
		exists: async (p) => {
			if (opts.failExists) throw new Error("boom");
			return p in files;
		},
		read: async (p) => {
			if (opts.failRead) throw new Error("boom");
			return files[p];
		},
		write: async (p, c) => {
			if (opts.failWrite) throw new Error("boom");
			files[p] = c;
			writes.push(p);
		},
	};
	return { s, files, writes };
}

test("parse: the three lines, the way the old reader read them", () => {
	assert.deepEqual(parseSettingsNote(template("Barovia", "Yes", "Location")), { primaryWorld: "Barovia", individualCommands: true, defaultCategory: "Location" });
	assert.equal(parseSettingsNote(template("Barovia", "yes", "Location")).individualCommands, true, "yes in any case");
	assert.equal(parseSettingsNote(template("Barovia", "No", "Location")).individualCommands, false);
});

test("parse: an empty world line, and lines that are not there, read as absent (null)", () => {
	assert.equal(parseSettingsNote(template("", "No", "Character")).primaryWorld, null);
	const none = parseSettingsNote("# OnlyWorlds Plugin Settings\n\nnothing here\n");
	assert.deepEqual(none, { primaryWorld: null, individualCommands: null, defaultCategory: null });
	assert.equal(holdsValues(none), false);
	assert.equal(holdsValues(parseSettingsNote(template("", "No", "Character"))), true);
});

test("parse: a world name with spaces and punctuation survives whole; CRLF endings parse the same", () => {
	assert.equal(parseSettingsNote(template("The Land of Mist (2)", "No", "Character")).primaryWorld, "The Land of Mist (2)");
	assert.deepEqual(parseSettingsNote(template("Barovia", "Yes", "Location").replace(/\n/g, "\r\n")), { primaryWorld: "Barovia", individualCommands: true, defaultCategory: "Location" });
});

test("apply: the note's reading is what was in effect: an empty world line is the top folder and a missing Yes/No is No, even over a pane value never acted on", () => {
	const paneTypedLongAgo = { defaultWorld: "Old", defaultCategory: "Object", individualElementCommands: true };
	assert.deepEqual(applyNoteValues(paneTypedLongAgo, { primaryWorld: null, individualCommands: null, defaultCategory: null }, CATS), {
		defaultWorld: "",
		defaultCategory: "Object", // no word in the note: the category the pane holds stays
		individualElementCommands: false,
	});
	assert.deepEqual(applyNoteValues(paneTypedLongAgo, { primaryWorld: "Barovia", individualCommands: true, defaultCategory: "Location" }, CATS), {
		defaultWorld: "Barovia",
		defaultCategory: "Location",
		individualElementCommands: true,
	});
	assert.equal(applyNoteValues(paneTypedLongAgo, { primaryWorld: null, individualCommands: null, defaultCategory: "Dragon" }, CATS).defaultCategory, "Object", "an invalid category is left out");
});

test("migrate: the plugin's own note moves its values and becomes a pointer WITH its old text beneath", async () => {
	const orig = template("Barovia", "Yes", "Location");
	const { s, files, writes } = store({ [SETTINGS_NOTE_PATH]: orig });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.deepEqual(r.settings, { defaultWorld: "Barovia", defaultCategory: "Location", individualElementCommands: true, settingsNoteMigrated: true });
	assert.match(r.notice ?? "", /moved to Obsidian's settings/);
	const now = files[SETTINGS_NOTE_PATH];
	assert.ok(now.startsWith(NOTE_HEADER) && now.includes(MOVED_MARK), "the pointer comes first");
	assert.ok(now.includes(orig.trim()), "the old text is kept whole beneath it");
	assert.deepEqual(writes, [SETTINGS_NOTE_PATH]);
});

test("★ migrate: what the user added below the plugin's template is not lost", async () => {
	const withMine = template("Barovia", "Yes", "Location") + "\n## My world notes\n\nThe sun never rises in the valley.\nRemember: ask Ireena about the amulet.\n";
	const { s, files } = store({ [SETTINGS_NOTE_PATH]: withMine });
	await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.ok(files[SETTINGS_NOTE_PATH].includes("The sun never rises in the valley."));
	assert.ok(files[SETTINGS_NOTE_PATH].includes("ask Ireena about the amulet."));
});

test("★ migrate: a second device, its own settings not yet migrated, reads the values kept beneath the pointer", async () => {
	const { s: first, files } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") });
	await migrateSettingsNote(first, DEFAULTS, CATS); // device one moves the note
	assert.ok(isMovedNote(files[SETTINGS_NOTE_PATH]));
	const { s: second, writes } = store({ ...files }); // device two receives the note, with the plugin's settings still at their defaults
	const r = await migrateSettingsNote(second, DEFAULTS, CATS);
	assert.deepEqual(r.settings, { defaultWorld: "Barovia", defaultCategory: "Location", individualElementCommands: true, settingsNoteMigrated: true });
	assert.deepEqual(writes, [], "the pointer is not rewritten or nested a second time");
});

test("migrate: it happens once (a second start with the flag set reads and writes nothing)", async () => {
	const { s, writes } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") });
	assert.deepEqual(await migrateSettingsNote(s, { ...DEFAULTS, settingsNoteMigrated: true }, CATS), { settings: null, notice: null });
	assert.deepEqual(writes, []);
});

test("★ migrate: no note is NOT marked done, so a note a sync delivers later is still carried over", async () => {
	const files: Record<string, string> = {};
	const { s, writes } = store(files);
	assert.deepEqual(await migrateSettingsNote(s, DEFAULTS, CATS), { settings: null, notice: null });
	files[SETTINGS_NOTE_PATH] = template("Barovia", "Yes", "Location"); // the note arrives
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.equal(r.settings?.defaultWorld, "Barovia");
	assert.deepEqual(writes, [SETTINGS_NOTE_PATH]);
});

test("migrate: a note the user made their own is read for its values but never rewritten", async () => {
	const own = "My own notes about the plugin.\n\n- **Primary World Name:** Barovia\n";
	const { s, files, writes } = store({ [SETTINGS_NOTE_PATH]: own });
	assert.equal(isPluginTemplateNote(own), false);
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.equal(r.settings?.defaultWorld, "Barovia");
	assert.equal(files[SETTINGS_NOTE_PATH], own, "untouched");
	assert.deepEqual(writes, []);
	assert.match(r.notice ?? "", /your own text/);
});

test("migrate: a note that holds no value at all is marked done in silence (no notice, no rewrite)", async () => {
	const { s, files, writes } = store({ [SETTINGS_NOTE_PATH]: "# OnlyWorlds Plugin Settings\n\nnothing here\n" });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.equal(r.notice, null);
	assert.equal(r.settings?.settingsNoteMigrated, true);
	assert.deepEqual(writes, []);
	assert.ok(!isMovedNote(files[SETTINGS_NOTE_PATH]));
});

test("migrate: an unreadable note changes nothing and is tried again next start", async () => {
	const { s } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") }, { failRead: true });
	assert.deepEqual(await migrateSettingsNote(s, DEFAULTS, CATS), { settings: null, notice: null });
	const { s: s2 } = store({}, { failExists: true });
	assert.deepEqual(await migrateSettingsNote(s2, DEFAULTS, CATS), { settings: null, notice: null });
});

test("migrate: a failed rewrite still carries the values over, marks done, and says the note could not be updated", async () => {
	const { s } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") }, { failWrite: true });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.equal(r.settings?.defaultWorld, "Barovia");
	assert.equal(r.settings?.settingsNoteMigrated, true);
	assert.match(r.notice ?? "", /could not be updated/);
});

test("the pointer text starts with the header and carries the mark; pointing at an empty original still reads", () => {
	const t = movedNoteText("");
	assert.ok(t.startsWith(NOTE_HEADER));
	assert.ok(isMovedNote(t));
	assert.equal(holdsValues(parseSettingsNote(t)), false);
});

test("CONTROL: a migration that drops the kept text is caught by the user-text test's own assertion", async () => {
	const withMine = template("Barovia", "Yes", "Location") + "\nMy words.\n";
	const { s, files } = store({ [SETTINGS_NOTE_PATH]: withMine });
	const dropper: NoteStore = { ...s, write: async (p) => { files[p] = movedNoteText("").trim(); } };
	await migrateSettingsNote(dropper, DEFAULTS, CATS);
	assert.ok(!files[SETTINGS_NOTE_PATH].includes("My words."), "a dropping writer loses the text, so the real test's includes() can go red");
});
