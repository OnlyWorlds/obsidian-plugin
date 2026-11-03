/**
 * The old Settings note, retired (OW Obsidian #1117). Written before the wiring: the note's values move into the
 * settings once, the note says where they went, and a note that is the user's own is never rewritten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NOTE_HEADER,
	SETTINGS_NOTE_PATH,
	applyNoteValues,
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
	const v = parseSettingsNote(template("Barovia", "Yes", "Location"));
	assert.deepEqual(v, { primaryWorld: "Barovia", individualCommands: true, defaultCategory: "Location" });
	assert.equal(parseSettingsNote(template("Barovia", "yes", "Location")).individualCommands, true, "yes in any case");
	assert.equal(parseSettingsNote(template("Barovia", "No", "Location")).individualCommands, false);
});

test("parse: an empty world line, and lines that are not there, read as absent (null), not as empty values", () => {
	const empty = parseSettingsNote(template("", "No", "Character"));
	assert.equal(empty.primaryWorld, null);
	const none = parseSettingsNote("# OnlyWorlds Plugin Settings\n\nnothing here\n");
	assert.deepEqual(none, { primaryWorld: null, individualCommands: null, defaultCategory: null });
});

test("parse: a world name with spaces and punctuation survives whole", () => {
	assert.equal(parseSettingsNote(template("The Land of Mist (2)", "No", "Character")).primaryWorld, "The Land of Mist (2)");
});

test("apply: the note wins where it speaks; an absent line leaves the setting; an invalid category is left out", () => {
	const cur = { defaultWorld: "Old", defaultCategory: "Object", individualElementCommands: false };
	assert.deepEqual(applyNoteValues(cur, { primaryWorld: "Barovia", individualCommands: true, defaultCategory: "Location" }, CATS), {
		defaultWorld: "Barovia",
		defaultCategory: "Location",
		individualElementCommands: true,
	});
	assert.deepEqual(applyNoteValues(cur, { primaryWorld: null, individualCommands: null, defaultCategory: null }, CATS), cur);
	assert.equal(applyNoteValues(cur, { primaryWorld: null, individualCommands: null, defaultCategory: "Dragon" }, CATS).defaultCategory, "Object");
	// a false from the note is a value too, not an absence
	assert.equal(applyNoteValues({ ...cur, individualElementCommands: true }, { primaryWorld: null, individualCommands: false, defaultCategory: null }, CATS).individualElementCommands, false);
});

test("migrate: the plugin's own note moves its values into the settings and then says where they went", async () => {
	const { s, files, writes } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.deepEqual(r.settings, { defaultWorld: "Barovia", defaultCategory: "Location", individualElementCommands: true, settingsNoteMigrated: true });
	assert.match(r.notice ?? "", /moved to Obsidian's settings/);
	assert.equal(r.retry, false);
	assert.equal(files[SETTINGS_NOTE_PATH], movedNoteText());
	assert.deepEqual(writes, [SETTINGS_NOTE_PATH]);
	assert.ok(!/Primary World Name/.test(files[SETTINGS_NOTE_PATH]), "the moved note no longer holds a line the old reader would act on");
});

test("migrate: it happens once (a second start with the flag set reads and writes nothing)", async () => {
	const { s, writes } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") });
	const r = await migrateSettingsNote(s, { ...DEFAULTS, settingsNoteMigrated: true }, CATS);
	assert.deepEqual(r, { settings: null, notice: null, retry: false });
	assert.deepEqual(writes, []);
});

test("migrate: no note at all is done quietly (marked, no notice, nothing written)", async () => {
	const { s, writes } = store({});
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.deepEqual(r.settings, { ...DEFAULTS, settingsNoteMigrated: true });
	assert.equal(r.notice, null);
	assert.deepEqual(writes, []);
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

test("migrate: an unreadable note is retried next start, not marked done", async () => {
	const { s } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") }, { failRead: true });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.deepEqual(r, { settings: null, notice: null, retry: true });
	const { s: s2 } = store({}, { failExists: true });
	assert.equal((await migrateSettingsNote(s2, DEFAULTS, CATS)).retry, true);
});

test("migrate: a failed rewrite still carries the values over and says the note could not be updated", async () => {
	const { s } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") }, { failWrite: true });
	const r = await migrateSettingsNote(s, DEFAULTS, CATS);
	assert.equal(r.settings?.defaultWorld, "Barovia");
	assert.match(r.notice ?? "", /could not be updated/);
});

test("the moved note starts with the header (so a second pass still knows it as ours) and holds no value line", () => {
	const t = movedNoteText();
	assert.ok(t.startsWith(NOTE_HEADER));
	assert.deepEqual(parseSettingsNote(t), { primaryWorld: null, individualCommands: null, defaultCategory: null });
});

test("CONTROL: the suite can fail (a migration that skips the rewrite is caught by the rewrite assertion)", async () => {
	const { s, files } = store({ [SETTINGS_NOTE_PATH]: template("Barovia", "Yes", "Location") });
	const noRewrite: NoteStore = { ...s, write: async () => {} };
	await migrateSettingsNote(noRewrite, DEFAULTS, CATS);
	assert.notEqual(files[SETTINGS_NOTE_PATH], movedNoteText());
});
