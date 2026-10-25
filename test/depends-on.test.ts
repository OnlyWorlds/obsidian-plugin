/**
 * The spine profile's dependency list as a section of wikilinks (OW Obsidian
 * #676): at pull, a note whose element carries `x_spine_depends_on` gains a
 * `### Depends on` section, last, one `[[note]]` line per id; the section is
 * never read as a field and never sent; a second pull writes it again from
 * the served list; a world without the list is written as before, byte for
 * byte.
 *
 * The profile's rule (schema-dist `profiles/spine.md`, serial 61):
 * "`x_spine_depends_on` | a list of element ids in this world, set on the
 * dependent only | a value that is not a list is not stated; non-string
 * entries are dropped; an empty list is stated (no dependencies), unlike an
 * empty address list; whether an id resolves is the world's audit, never the
 * reader's."
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { writeElement, readElement } from "../vault/element-file";
import { dependsOnSection, dependsOnOwnText, dependsOnKeptMessage, withoutDependsOn, withDependsOn, isDependsOnHeading } from "../vault/element-transform";
import { harnessSave } from "./support/save-harness";
import { splitNote } from "../vault/element-transform";
import { sanitizeFileName } from "../Scripts/WorldService";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";
const KREZK = "019e0000-0000-7000-8000-0000000000a2";
const ARGYNVOST = "019e0000-0000-7000-8000-0000000000a3";
const GONE = "019e0000-0000-7000-8000-0000000000ff"; // an id with no element in the world
const SDK = "019e0000-0000-7000-8000-0000000000b1";
const SDK_NAME = "@onlyworlds/sdk"; // a name a file name cannot hold: the slash
const SDK_NOTE = sanitizeFileName(SDK_NAME); // what the plugin's own rule makes of it

const upsert = (id: string, name: string, seq: number, extra: Record<string, unknown> = {}) => ({
	op: "upsert", type: "location", id, change_seq: seq, updated_at: "x", element: { id, name, ...extra },
});

interface Pulled {
	app: ReturnType<typeof makeApp>["app"];
	plugin: { settings: { syncCursors: Record<string, unknown>; deletedOnServer: Record<string, string[]> }; saveSettings: () => Promise<void> };
}

/** A Download World run against a served change list; `prior` reuses a vault and its settings for a second pull. */
async function pull(changes: unknown[], prior?: Pulled): Promise<Pulled> {
	const made: Pulled = prior ?? { app: makeApp().app, plugin: { settings: { syncCursors: {}, deletedOnServer: {} }, saveSettings: async () => {} } };
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: "c9", has_more: false, head: 9, changes } };
		return { status: 404, json: {} };
	});
	const cmd = new DownloadWorldCommand(made.app, { version: "t" }, made.plugin as never);
	assert.equal(await cmd.downloadWithKey("ow_k_test", "1234"), "Barovia");
	return made;
}

async function note(made: Pulled, name: string): Promise<{ file: TFile; text: string }> {
	const file = made.app.vault.getMarkdownFiles().find((f) => f.path.includes("/Elements/") && f.basename === name);
	assert.ok(file, `no note ${name}`);
	return { file: file as unknown as TFile, text: await made.app.vault.read(file) };
}

const SECTION_OF = (text: string) => text.slice(text.indexOf("### Depends on"));

// --- the section itself ------------------------------------------------------

test("dependsOnSection: one line per id in the list's order, a gap named, never dropped", () => {
	const names: Record<string, string> = { [VALLAKI]: "Vallaki", [ARGYNVOST]: "Argynvostholt" };
	const s = dependsOnSection([ARGYNVOST, GONE, VALLAKI], (id) => names[id] ?? null);
	assert.equal(s, `### Depends on\n\n- [[Argynvostholt]]\n- (not in this vault: ${GONE})\n- [[Vallaki]]\n`);
});

test("dependsOnSection: no section for an empty, absent or non-list value; non-string entries dropped", () => {
	const r = () => "X";
	assert.equal(dependsOnSection([], r), "");
	assert.equal(dependsOnSection(undefined, r), "");
	assert.equal(dependsOnSection(VALLAKI, r), "", "a value that is not a list is not stated");
	assert.equal(dependsOnSection([1, null, { id: VALLAKI }], r), "", "no string entry: no id");
	assert.equal(dependsOnSection([1, VALLAKI, null], r), "### Depends on\n\n- [[X]]\n");
});

test("withoutDependsOn takes the section out wherever it stands; withDependsOn puts it back last", () => {
	const body = "### Description\n\nA town.\n\n### Depends on\n\n- [[Vallaki]]\n\n### Looks\n\nGrey.\n\n";
	const { body: own, section } = withoutDependsOn(body);
	assert.equal(own, "### Description\n\nA town.\n\n### Looks\n\nGrey.\n\n");
	assert.equal(section, "### Depends on\n\n- [[Vallaki]]\n\n");
	assert.equal(withDependsOn(own, section), `${own}${section}`);
	const plain = "### Description\n\nA town.\n\n### Depended On By\n\nKrezk.\n";
	assert.deepEqual(withoutDependsOn(plain), { body: plain, section: "" }, "a body without the heading keeps every section");
});

test("isDependsOnHeading: exactly \"Depends on\", trimmed, in any case", () => {
	for (const h of ["Depends on", "depends on", "DEPENDS ON", "  Depends On  "]) assert.equal(isDependsOnHeading(h), true, h);
	for (const h of ["Depends", "Depends  on", "Depends_on", "Depends on:", "Depended on"]) assert.equal(isDependsOnHeading(h), false, h);
});

// --- at pull -----------------------------------------------------------------

test("★ a pull writes the section last: three ids, two resolve, one does not, in the list's order", async () => {
	const made = await pull([
		upsert(VALLAKI, "Vallaki", 1),
		upsert(ARGYNVOST, "Argynvostholt", 2),
		upsert(KREZK, "Krezk", 3, { description: "A walled village.", x_spine_depends_on: [ARGYNVOST, GONE, VALLAKI] }),
	]);
	const { text } = await note(made, "Krezk");
	assert.ok(text.endsWith(`### Depends on\n\n- [[Argynvostholt]]\n- (not in this vault: ${GONE})\n- [[Vallaki]]\n\n`), text);
	assert.equal(text.split("### Depends on").length, 2, "one section");
	assert.ok(text.indexOf("A walled village.") < text.indexOf("### Depends on"), "the section goes last");
	assert.match(text, new RegExp(`x_spine_depends_on:\\n  - ${ARGYNVOST}\\n  - ${GONE}\\n  - ${VALLAKI}\\n`), "the list stays in the frontmatter as served");
	for (const other of ["Vallaki", "Argynvostholt"]) assert.ok(!(await note(made, other)).text.includes("Depends on"), other);
});

test("★ no section for an empty or absent list", async () => {
	const made = await pull([
		upsert(VALLAKI, "Vallaki", 1, { x_spine_depends_on: [] }),
		upsert(KREZK, "Krezk", 2),
	]);
	const v = (await note(made, "Vallaki")).text;
	assert.ok(!v.includes("Depends on"), v);
	assert.match(v, /x_spine_depends_on: \[\]/, "an empty list is stated by the frontmatter");
	assert.ok(!(await note(made, "Krezk")).text.includes("Depends on"));
});

test("★ a second pull writes the section's list again from the served list; a list that became empty takes it away", async () => {
	const first = await pull([
		upsert(VALLAKI, "Vallaki", 1),
		upsert(ARGYNVOST, "Argynvostholt", 2),
		upsert(KREZK, "Krezk", 3, { x_spine_depends_on: [VALLAKI, ARGYNVOST] }),
	]);
	// The second pull carries only the changed element (Vallaki and
	// Argynvostholt resolve through the notes already on disk).
	await pull([upsert(KREZK, "Krezk", 4, { x_spine_depends_on: [ARGYNVOST] })], first);
	const second = (await note(first, "Krezk")).text;
	assert.equal(SECTION_OF(second), "### Depends on\n\n- [[Argynvostholt]]\n\n");

	await pull([upsert(KREZK, "Krezk", 5, { x_spine_depends_on: [] })], first);
	const third = (await note(first, "Krezk")).text;
	assert.ok(!third.includes("Depends on"), third);
});

test("a known-of note written twice keeps one section, never the old one as the person's", async () => {
	const { app } = makeApp();
	const data = { name: "Krezk", x_spine_depends_on: [VALLAKI] };
	await writeElement(app, "W", "location", KREZK, data, { knownOf: true, idToName: () => "Vallaki" });
	const file = await writeElement(app, "W", "location", KREZK, data, { knownOf: true, idToName: () => "Vallaki" });
	const text = await app.vault.read(file);
	assert.equal(text.split("### Depends on").length, 2, text);
	assert.ok(text.endsWith("### Depends on\n\n- [[Vallaki]]\n\n"), text);
});

// --- at push -----------------------------------------------------------------

const SPINE_NOTE = (description: string, extraLine = "") =>
	`---\nname: Krezk\nid: ${KREZK}\nx_spine_depends_on:\n  - ${VALLAKI}\n  - ${GONE}\n---\n\n` +
	`### Description\n\n${description}\n\n### Depends on\n\n- [[Vallaki]]\n${extraLine}- (not in this vault: ${GONE})\n\n`;
const VALLAKI_NOTE = `---\nname: Vallaki\nid: ${VALLAKI}\n---\n\n### Description\n\n\n`;

/** Every key of a payload, nested ones included. */
const keysOf = (v: unknown): string[] =>
	v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

test("★ readElement: the section is no field and folds into nothing; the list is the frontmatter's", async () => {
	const { app, vault } = makeApp();
	const file = (await vault.seed("OnlyWorlds/Worlds/W/Elements/Location/Krezk.md", SPINE_NOTE("A walled village.", "- typed by hand\n"))) as unknown as TFile;
	const read = await readElement(app, file);
	assert.ok(read);
	assert.equal(read.fields.description, "A walled village.");
	assert.deepEqual(read.fields.x_spine_depends_on, [VALLAKI, GONE]);
	assert.deepEqual(keysOf(read.fields).filter((k) => /depends/i.test(k)), ["x_spine_depends_on"]);
	assert.ok(!JSON.stringify(read.fields).includes("typed by hand"));
});

test("★ a save of an edited note sends the description, and the list only as served (already on the server: not sent)", async () => {
	const r = await harnessSave({
		notes: { "Location/Krezk.md": SPINE_NOTE("A walled village, edited.", "- typed by hand\n"), "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, GONE] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1);
	assert.equal(r.sent[0].description, "A walled village, edited.");
	const depends = keysOf(r.sent[0]).filter((k) => /depends/i.test(k));
	assert.ok(depends.every((k) => k === "x_spine_depends_on"), `payload keys: ${depends.join(", ")}`);
	if ("x_spine_depends_on" in r.sent[0]) assert.deepEqual(r.sent[0].x_spine_depends_on, [VALLAKI, GONE]);
	assert.ok(!JSON.stringify(r.sent).includes("typed by hand"));
	assert.ok(!JSON.stringify(r.sent).includes("Depends on"));
});

test("★ a save to a server copy without the list sends it exactly as the frontmatter holds it", async () => {
	const r = await harnessSave({
		notes: { "Location/Krezk.md": SPINE_NOTE("A walled village."), "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village." } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ x_spine_depends_on: [VALLAKI, GONE] }]);
});

// --- worlds without the list --------------------------------------------------

test("★ the key deleted from Properties, the section left: a save sends nothing named depends_on, and the section stays as it is", async () => {
	// The leak the heading-alone rule closes: owned by the key too, this
	// section read as a custom field and went out as x_depends_on.
	const edited = SPINE_NOTE("A walled village, edited.", "- typed by hand\n").replace(`x_spine_depends_on:\n  - ${VALLAKI}\n  - ${GONE}\n`, "");
	assert.ok(!edited.includes("x_spine_depends_on") && edited.includes("### Depends on"));
	const r = await harnessSave({
		notes: { "Location/Krezk.md": edited, "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, GONE] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ description: "A walled village, edited." }]);
	assert.deepEqual(keysOf(r.sent).filter((k) => /depends/i.test(k)), []);
	assert.ok(!JSON.stringify(r.sent).includes("typed by hand"));
	// Save does not rewrite the body: the section stays until the next pull.
	const after = await r.app.vault.read(r.files["Location/Krezk.md"]);
	assert.ok(after.includes("### Depends on\n\n- [[Vallaki]]\n- typed by hand\n"), after);
});

test("a `### Depends on` in any note is no field, in any case; an element's own x_depends_on stays in the frontmatter", async () => {
	const { app, vault } = makeApp();
	const file = (await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Location/Krezk.md",
		`---\nname: Krezk\nid: ${KREZK}\n---\n\n### Description\n\nA village.\n\n### depends ON\n\nThe pass.\n`
	)) as unknown as TFile;
	const read = await readElement(app, file);
	assert.equal(read?.fields.description, "A village.");
	assert.deepEqual(keysOf(read?.fields).filter((k) => /depends/i.test(k)), []);

	const written = await writeElement(app, "W", "location", VALLAKI, { name: "Vallaki", x_depends_on: "The road." });
	const text = await app.vault.read(written);
	assert.ok(!/### Depends on/i.test(text), "never a section of its own");
	assert.equal((await readElement(app, written))?.fields.x_depends_on, "The road.", "sent from the frontmatter, verbatim");
});

/**
 * ★ A world with no list anywhere is written byte for byte as 3.11.0 wrote
 * it. The expected note is the one the 3.11.0 code (main 938e44f) wrote for
 * this same pull, captured from a run of that code: a supertype, a
 * description, the scaffold of every other field, and a non-spine `x_` list.
 */
const PLAIN_EXPECTED =
	"---\nname: Krezk\nid: 019e0000-0000-7000-8000-0000000000a2\nsupertype: village\nsubtype: \"\"\nimage_url: \"\"\nfounding_date:\nelevation:\nparent_location: \"\"\npopulations: []\nprimary_power: \"\"\ngoverning_title: \"\"\nsecondary_powers: []\nzone: \"\"\nrival: \"\"\npartner: \"\"\nfounders: []\ncults: []\ndelicacies: []\nextraction_methods: []\nextraction_goods: []\nindustry_methods: []\nindustry_goods: []\nextraction_markets: []\nindustry_markets: []\ncurrencies: []\nbuildings: []\nbuilding_methods: []\nfighters: []\ndefensive_objects: []\nx_tags:\n  - walled\n  - abbey\n---\n\n### Description\n\nA walled village.\n\n### Form\n\n\n### Function\n\n\n### Political Climate\n\n\n### Customs\n\n\n### Infrastructure\n\n\n### Architecture\n\n\n### Defensibility\n\n\n";

test("★ a pull of a world without the list writes the note as 3.11.0 did, byte for byte", async () => {
	const made = await pull([
		upsert(VALLAKI, "Vallaki", 1),
		upsert(KREZK, "Krezk", 2, { supertype: "village", description: "A walled village.", x_tags: ["walled", "abbey"] }),
	]);
	const { text } = await note(made, "Krezk");
	assert.equal(text, PLAIN_EXPECTED);
});

// --- a person's own lines under the heading -----------------------------------

test("dependsOnOwnText: every line but the heading, the generated ones and the blank edges", () => {
	assert.equal(dependsOnOwnText(`### Depends on\n\n- [[Vallaki]]\n- (not in this vault: ${GONE})\n\n`), "");
	assert.equal(dependsOnOwnText("### Depends on\n\n- [[Vallaki]]\n- my own line\n\nAnd a note.\n\n"), "- my own line\n\nAnd a note.");
	assert.equal(dependsOnOwnText("### depends ON\r\n\r\nThe pass.\r\n"), "The pass.");
	assert.equal(dependsOnOwnText(""), "");
});

const KEPT = dependsOnKeptMessage("Krezk");

test("★ a save of a note with a line of its own under Depends on: one notice naming the note, no field sent", async () => {
	const r = await harnessSave({
		notes: { "Location/Krezk.md": SPINE_NOTE("A walled village.", "- typed by hand\n"), "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, GONE] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [], "the section is no field: nothing to send");
	assert.equal(r.notices.filter((n) => n === KEPT).length, 1, r.notices.join(" | "));
	assert.equal(KEPT, "\"Depends on\" is the section the plugin writes from a dependency list, so it is not sent. Your lines under it in \"Krezk\" were kept in the note.");
	const after = await r.app.vault.read(r.files["Location/Krezk.md"]);
	assert.ok(after.includes("- typed by hand\n"), "the line stays in the note");
});

test("★ a save of a note with only generated lines under Depends on: no notice", async () => {
	const r = await harnessSave({
		notes: { "Location/Krezk.md": SPINE_NOTE("A walled village, edited."), "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, GONE] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ description: "A walled village, edited." }]);
	assert.ok(!r.notices.some((n) => n.includes("Depends on")), r.notices.join(" | "));
});

test("auto-sync names the kept lines once a session per note, a manual save every time", async () => {
	const opts = (manual: boolean) => ({
		notes: { "Location/Krezk.md": SPINE_NOTE("A walled village.", "- typed by hand\n"), "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, GONE] } },
		manual,
	});
	const counts: number[] = [];
	for (const manual of [false, false, true]) {
		const r = await harnessSave(opts(manual));
		counts.push(r.notices.filter((n) => n === KEPT).length);
	}
	assert.deepEqual(counts, [1, 0, 1]);
});

test("★ a pull keeps a person's line under Depends on, after the generated list; a second pull does not double it", async () => {
	const first = await pull([
		upsert(VALLAKI, "Vallaki", 1),
		upsert(ARGYNVOST, "Argynvostholt", 2),
		upsert(KREZK, "Krezk", 3, { x_spine_depends_on: [VALLAKI, ARGYNVOST] }),
	]);
	// The person writes inside the generated section, between its lines.
	const before = await note(first, "Krezk");
	await first.app.vault.modify(before.file as never, before.text.replace("- [[Vallaki]]\n", "- [[Vallaki]]\n- my own line\n"));

	await pull([upsert(KREZK, "Krezk", 4, { x_spine_depends_on: [ARGYNVOST, VALLAKI] })], first);
	const second = (await note(first, "Krezk")).text;
	assert.equal(SECTION_OF(second), "### Depends on\n\n- [[Argynvostholt]]\n- [[Vallaki]]\n\n- my own line\n\n");

	await pull([upsert(KREZK, "Krezk", 5, { x_spine_depends_on: [ARGYNVOST, VALLAKI] })], first);
	assert.equal((await note(first, "Krezk")).text, second, "the same note, the line once");

	// The list emptied: the heading stays for the person's line alone.
	await pull([upsert(KREZK, "Krezk", 6, { x_spine_depends_on: [] })], first);
	assert.equal(SECTION_OF((await note(first, "Krezk")).text), "### Depends on\n\n- my own line\n\n");
});

// --- a name a file name cannot hold -------------------------------------------

test("dependsOnSection: a dependency whose real name differs from its note name shows the real name as an alias; a plain name stays plain", () => {
	const notes: Record<string, string> = { [SDK]: SDK_NOTE, [VALLAKI]: "Vallaki" };
	const real: Record<string, string> = { [SDK]: SDK_NAME, [VALLAKI]: "Vallaki" };
	const s = dependsOnSection([SDK, VALLAKI, GONE], (id) => notes[id] ?? null, "", (id) => real[id] ?? null);
	assert.notEqual(SDK_NOTE, SDK_NAME, "the fixture name is one the file-name rule changes");
	assert.equal(s, `### Depends on\n\n- [[${SDK_NOTE}|${SDK_NAME}]]\n- [[Vallaki]]\n- (not in this vault: ${GONE})\n`);
	// No real-name resolver: the section is as it was.
	assert.equal(dependsOnSection([SDK], (id) => notes[id] ?? null), `### Depends on\n\n- [[${SDK_NOTE}]]\n`);
});

test("dependsOnSection: a real name that would break the link line is not used as the alias", () => {
	for (const bad of ["a [b] c", "x]]y", "two\nlines"]) {
		const s = dependsOnSection([SDK], () => "plain-note", "", () => bad);
		assert.equal(s, "### Depends on\n\n- [[plain-note]]\n", JSON.stringify(bad));
	}
	assert.equal(dependsOnSection([SDK], () => "plain-note", "", () => ""), "### Depends on\n\n- [[plain-note]]\n", "no real name");
});

test("dependsOnOwnText: an alias line is a generated line, never a person's", () => {
	assert.equal(dependsOnOwnText(`### Depends on\n\n- [[${SDK_NOTE}|${SDK_NAME}]]\n- [[Vallaki]]\n\n`), "");
	assert.equal(dependsOnOwnText(`### Depends on\n\n- [[${SDK_NOTE}|${SDK_NAME}]]\n- my own line\n\n`), "- my own line");
});

const SDK_PULL = () => [
	upsert(VALLAKI, "Vallaki", 1),
	upsert(SDK, SDK_NAME, 2),
	upsert(KREZK, "Krezk", 3, { x_spine_depends_on: [SDK, VALLAKI] }),
];
const SDK_SECTION = `### Depends on\n\n- [[${SDK_NOTE}|${SDK_NAME}]]\n- [[Vallaki]]\n\n`;

test("★ a pull shows a dependency's real name when its note name differs; a clean name is the plain line", async () => {
	const made = await pull(SDK_PULL());
	const { text } = await note(made, "Krezk");
	assert.equal(SECTION_OF(text), SDK_SECTION);
	assert.ok((await note(made, SDK_NOTE)).text.startsWith(`---\nname: ${SDK_NAME}\n`) || (await note(made, SDK_NOTE)).text.includes(SDK_NAME), "the element keeps its real name in its note");
});

test("★ a second pull resolves the dependency from the note on disk: the alias line once, no kept lines", async () => {
	const first = await pull(SDK_PULL());
	const before = (await note(first, "Krezk")).text;
	// Only the dependent changes; the dependency's real name comes from its note.
	await pull([upsert(KREZK, "Krezk", 4, { x_spine_depends_on: [SDK, VALLAKI] })], first);
	const second = (await note(first, "Krezk")).text;
	assert.equal(second, before, "the same note");
	assert.equal(second.split(`[[${SDK_NOTE}|${SDK_NAME}]]`).length, 2, "the alias line once");
	await pull([upsert(KREZK, "Krezk", 5, { x_spine_depends_on: [SDK, VALLAKI] })], first);
	assert.equal((await note(first, "Krezk")).text, before, "and a third time");
	assert.equal(dependsOnOwnText(withoutDependsOn(splitNote(second).body).section), "", "nothing in it reads as the person's");
});

const SDK_SPINE_NOTE = `---\nname: Krezk\nid: ${KREZK}\nx_spine_depends_on:\n  - ${SDK}\n  - ${VALLAKI}\n---\n\n### Description\n\nA walled village.\n\n${SDK_SECTION}`;
const SDK_DEP_NOTE = `---\nname: ${SDK_NAME}\nid: ${SDK}\n---\n\n### Description\n\n\n`;

test("★ a save of a note holding an alias line sends no field and raises no kept-lines notice", async () => {
	const r = await harnessSave({
		notes: { "Location/Krezk.md": SDK_SPINE_NOTE, [`Location/${SDK_NOTE}.md`]: SDK_DEP_NOTE, "Location/Vallaki.md": VALLAKI_NOTE },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [SDK, VALLAKI] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [], "the section is no field: nothing to send");
	assert.ok(!r.notices.some((n) => n.includes("Depends on")), r.notices.join(" | "));
});

test("★ a plain world: a Depends on heading typed by hand survives the next pull, its text kept", async () => {
	const first = await pull([upsert(KREZK, "Krezk", 1, { description: "A walled village." })]);
	const before = await note(first, "Krezk");
	await first.app.vault.modify(before.file as never, `${before.text}### Depends on\n\nThe pass road.\n`);
	await pull([upsert(KREZK, "Krezk", 2, { description: "A walled village, rebuilt." })], first);
	const after = (await note(first, "Krezk")).text;
	assert.ok(after.includes("A walled village, rebuilt."), after);
	assert.ok(after.endsWith("### Depends on\n\nThe pass road.\n\n"), after);
	assert.equal(after.split("### Depends on").length, 2, "one section");
});
