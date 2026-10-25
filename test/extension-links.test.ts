/**
 * Extension keys that hold element ids show as links (3.13.0). An `x_`,
 * `atlas_` or `shadow_` key whose whole value is an element id, or a list of
 * them, is written at pull as `[[note]]` (a list as a list of links), exactly
 * as a schema link field is, and read back as the id (or the list of ids) on
 * save. The rule takes the whole value or nothing: a value that is not an id,
 * or a list with one entry that is not, is written and sent as it came. An id
 * no note answers stays the bare id. A note written before 3.13.0, with bare
 * ids under the key, saves the same ids.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { readElement } from "../vault/element-file";
import { apiDataToFrontmatter, frontmatterToPayloadFields, extensionLinksOut, AMBIGUOUS_LINK as AMBIG } from "../vault/element-transform";
import { harnessSave } from "./support/save-harness";
import { sanitizeFileName } from "../Scripts/WorldService";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";
const KREZK = "019e0000-0000-7000-8000-0000000000a2";
const ARGYNVOST = "019e0000-0000-7000-8000-0000000000a3";
const GONE = "019e0000-0000-7000-8000-0000000000ff"; // an id with no element in the world
const SDK = "019e0000-0000-7000-8000-0000000000b1";
const SDK_NAME = "@onlyworlds/sdk"; // a name a file name cannot hold: the slash
const SDK_NOTE = sanitizeFileName(SDK_NAME);

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

/** Krezk's extension keys: a list of ids, one id, a list with a word in it, and an id no element has. */
const KREZK_KEYS = {
	x_spine_depends_on: [VALLAKI, ARGYNVOST],
	atlas_capital: VALLAKI,
	x_ruler: ARGYNVOST, // a string under x_ is also a body section, which keeps the id as served
	atlas_page_refs: [VALLAKI, "not an id"],
	shadow_lost: GONE,
	x_mood: "wary",
};
const WORLD = () => [
	upsert(VALLAKI, "Vallaki", 1),
	upsert(ARGYNVOST, "Argynvostholt", 2),
	upsert(KREZK, "Krezk", 3, { description: "A walled village.", ...KREZK_KEYS }),
];

// --- the transform ---------------------------------------------------------

test("extensionLinksOut: whole values only; an id no note answers stays the id", () => {
	const names: Record<string, string> = { [VALLAKI]: "Vallaki", [ARGYNVOST]: "Argynvostholt" };
	const r = (id: string) => names[id] ?? null;
	assert.deepEqual(extensionLinksOut([VALLAKI, ARGYNVOST], r), ["[[Vallaki]]", "[[Argynvostholt]]"]);
	assert.equal(extensionLinksOut(VALLAKI, r), "[[Vallaki]]");
	assert.equal(extensionLinksOut(GONE, r), GONE);
	assert.deepEqual(extensionLinksOut([VALLAKI, GONE], r), ["[[Vallaki]]", GONE]);
	assert.deepEqual(extensionLinksOut([VALLAKI, "not an id"], r), [VALLAKI, "not an id"], "one entry that is no id: the list as it came");
	assert.deepEqual(extensionLinksOut([VALLAKI, 3], r), [VALLAKI, 3]);
	assert.deepEqual(extensionLinksOut([], r), []);
	assert.equal(extensionLinksOut("wary", r), "wary");
	assert.equal(extensionLinksOut(`${VALLAKI} and more`, r), `${VALLAKI} and more`);
	assert.deepEqual(extensionLinksOut({ id: VALLAKI }, r), { id: VALLAKI });
	assert.deepEqual(extensionLinksOut([VALLAKI], undefined), [VALLAKI], "no resolver: as it came");
});

test("extensionLinksOut: the real name as the alias where the note's name differs", () => {
	const out = extensionLinksOut([SDK, VALLAKI], (id) => (id === SDK ? SDK_NOTE : "Vallaki"), (id) => (id === SDK ? SDK_NAME : "Vallaki"));
	assert.deepEqual(out, [`[[${SDK_NOTE}|${SDK_NAME}]]`, "[[Vallaki]]"]);
});

test("apiDataToFrontmatter -> frontmatterToPayloadFields: every shape comes back as served", () => {
	const names: Record<string, string> = { [VALLAKI]: "Vallaki", [ARGYNVOST]: "Argynvostholt" };
	const fm = apiDataToFrontmatter({ id: KREZK, name: "Krezk", ...KREZK_KEYS }, "location", KREZK, {
		resolveIdToName: (id) => names[id] ?? null,
	});
	assert.deepEqual(fm.x_spine_depends_on, ["[[Vallaki]]", "[[Argynvostholt]]"]);
	assert.equal(fm.atlas_capital, "[[Vallaki]]");
	assert.deepEqual(fm.atlas_page_refs, [VALLAKI, "not an id"]);
	assert.equal(fm.shadow_lost, GONE);
	const ids: Record<string, string> = { vallaki: VALLAKI, argynvostholt: ARGYNVOST };
	const targets: (string | undefined)[] = [];
	const back = frontmatterToPayloadFields(fm, "location", {
		resolveNameToId: (n, t) => { targets.push(t); return ids[n.toLowerCase()] ?? null; },
		omitFieldOnUnresolved: true,
	});
	for (const [k, v] of Object.entries(KREZK_KEYS)) assert.deepEqual(back[k], v, k);
	assert.ok(targets.every((t) => t === "any"), "an extension key names no type: any type answers");
});

test("frontmatterToPayloadFields: a gap beside an element id leaves the key out, named; ambiguous too; links to ordinary notes alone go as text", () => {
	const unresolved: string[] = [];
	const ambiguous: string[] = [];
	const out = frontmatterToPayloadFields(
		{
			id: KREZK, name: "Krezk",
			x_spine_depends_on: ["[[Vallaki]]", "[[Nowhere]]"],
			x_beside_bare: [VALLAKI, "[[Nowhere]]"],
			atlas_capital: "[[Twin]]",
			x_other: ["[[Vallaki]]"],
			x_sources: "[[Reading notes]]",
			x_reading: ["[[Reading notes]]", "[[Essay]]"],
		},
		"location",
		{
			resolveNameToId: (n) => (n === "Vallaki" ? VALLAKI : n === "Twin" ? AMBIG : null),
			unresolved,
			ambiguous,
			omitFieldOnUnresolved: true,
		}
	);
	assert.ok(!("x_spine_depends_on" in out), "never a shortened list: the server keeps its value");
	assert.ok(!("x_beside_bare" in out), "a bare id is an element id too");
	assert.ok(!("atlas_capital" in out));
	assert.deepEqual(out.x_other, [VALLAKI]);
	assert.equal(out.x_sources, "[[Reading notes]]");
	assert.deepEqual(out.x_reading, ["[[Reading notes]]", "[[Essay]]"]);
	assert.deepEqual(unresolved, ["Nowhere", "Nowhere"], "links to ordinary notes are never reported");
	assert.deepEqual(ambiguous, ["Twin"]);
});

test("frontmatterToPayloadFields: a link beside a word, or without a resolver, goes as it is", () => {
	const fm = { id: KREZK, name: "Krezk", x_notes: ["[[Vallaki]]", "see the map"], atlas_capital: "[[Vallaki]]" };
	const withWord = frontmatterToPayloadFields(fm, "location", { resolveNameToId: () => VALLAKI, omitFieldOnUnresolved: true });
	assert.deepEqual(withWord.x_notes, ["[[Vallaki]]", "see the map"]);
	const bare = frontmatterToPayloadFields(fm, "location");
	assert.equal(bare.atlas_capital, "[[Vallaki]]");
});

// --- at pull ---------------------------------------------------------------

test("★ a pull writes extension ids as links: a list, a single id, a list with a word, an unknown id", async () => {
	const made = await pull(WORLD());
	const { text } = await note(made, "Krezk");
	assert.ok(text.includes(`x_spine_depends_on:\n  - "[[Vallaki]]"\n  - "[[Argynvostholt]]"\n`), text);
	assert.ok(text.includes(`atlas_capital: "[[Vallaki]]"\n`), text);
	assert.ok(text.includes(`x_ruler: "[[Argynvostholt]]"\n`), text);
	assert.ok(text.includes(`### Ruler\n\n${ARGYNVOST}\n`), text);
	assert.ok(text.includes(`atlas_page_refs:\n  - ${VALLAKI}\n  - not an id\n`), text);
	assert.ok(text.includes(`shadow_lost: ${GONE}\n`), text);
	assert.ok(!text.includes("[[Unknown]]") && !text.includes(`[[${GONE}]]`));
	assert.ok(text.includes("x_mood: wary\n"));
	// The generated Depends on section is written as before, beside the links.
	assert.ok(text.includes("### Depends on\n\n- [[Vallaki]]\n- [[Argynvostholt]]\n"), text);
});

test("★ a pull of a dependency whose name a file name cannot hold writes the alias", async () => {
	const made = await pull([
		upsert(SDK, SDK_NAME, 1),
		upsert(KREZK, "Krezk", 2, { x_spine_depends_on: [SDK] }),
	]);
	const { text } = await note(made, "Krezk");
	assert.ok(text.includes(`x_spine_depends_on:\n  - "[[${SDK_NOTE}|${SDK_NAME}]]"\n`), text);
});

test("★ the round trip: a note pulled reads back the served ids, and a second pull changes no byte", async () => {
	const made = await pull(WORLD());
	const first = await note(made, "Krezk");
	const read = await readElement(made.app, first.file);
	assert.ok(read, "the note reads");
	for (const [k, v] of Object.entries(KREZK_KEYS)) assert.deepEqual(read.fields[k], v, k);
	assert.deepEqual(read.unresolvedLinks, []);
	assert.deepEqual(read.ambiguousLinks, []);
	await pull(WORLD(), made);
	assert.equal((await note(made, "Krezk")).text, first.text);
});

// --- at save ---------------------------------------------------------------

test("★ a save sends the links back as ids, a list as a list and one link as a string", async () => {
	const made = await pull(WORLD());
	const krezk = (await note(made, "Krezk")).text;
	const vallaki = (await note(made, "Vallaki")).text;
	const argynvost = (await note(made, "Argynvostholt")).text;
	const r = await harnessSave({
		notes: { "Location/Krezk.md": krezk, "Location/Vallaki.md": vallaki, "Location/Argynvostholt.md": argynvost },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village." } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1);
	for (const [k, v] of Object.entries(KREZK_KEYS)) assert.deepEqual(r.sent[0][k], v, k);
	assert.deepEqual(r.notices.filter((n) => /Not saved/.test(n)), []);
});

test("★ a save against a server holding the same ids sends none of the extension keys", async () => {
	const made = await pull(WORLD());
	const r = await harnessSave({
		notes: {
			"Location/Krezk.md": (await note(made, "Krezk")).text,
			"Location/Vallaki.md": (await note(made, "Vallaki")).text,
			"Location/Argynvostholt.md": (await note(made, "Argynvostholt")).text,
		},
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", ...KREZK_KEYS } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	const sentKeys = r.sent.flatMap((b) => Object.keys(b));
	assert.deepEqual(sentKeys.filter((k) => k in KREZK_KEYS), [], "no extension key differs from the server's");
});

test("★ a custom field linking an ordinary note saves as text, as in 3.12.1, with no Notice", async () => {
	const krezk = `---\nname: Krezk\nid: ${KREZK}\nx_sources: "[[Reading notes]]"\n---\n\n### Description\n\nA walled village.\n`;
	const r = await harnessSave({
		notes: { "Location/Krezk.md": krezk },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_sources: "[[Old notes]]" } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ x_sources: "[[Reading notes]]" }]);
	assert.deepEqual(r.notices.filter((n) => /Not saved/.test(n)), []);
});

test("★ one link resolved and one not under an extension key: the key is left out, with the links Notice", async () => {
	const krezk = `---\nname: Krezk\nid: ${KREZK}\nx_spine_depends_on:\n  - "[[Vallaki]]"\n  - "[[Nowhere]]"\natlas_capital: "[[Vallaki]]"\n---\n\n### Description\n\nA walled village.\n`;
	const vallaki = `---\nname: Vallaki\nid: ${VALLAKI}\n---\n\n### Description\n\n`;
	const r = await harnessSave({
		notes: { "Location/Krezk.md": krezk, "Location/Vallaki.md": vallaki },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", x_spine_depends_on: [VALLAKI, ARGYNVOST] } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ atlas_capital: VALLAKI }]);
	assert.ok(r.notices.some((n) => n.includes("Not saved to those links: Nowhere.")), r.notices.join(" | "));
});

test("★ a note from 3.12.1, bare ids under the extension keys, saves the same ids", async () => {
	const krezk = `---\nname: Krezk\nid: ${KREZK}\nx_spine_depends_on:\n  - ${VALLAKI}\n  - ${GONE}\natlas_capital: ${VALLAKI}\n---\n\n### Description\n\nA walled village.\n`;
	const r = await harnessSave({
		notes: { "Location/Krezk.md": krezk },
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village." } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [{ x_spine_depends_on: [VALLAKI, GONE], atlas_capital: VALLAKI }]);
});

test("★ an id another tool wrote in capitals: its pull and save change no byte and no value", async () => {
	const UPPER = VALLAKI.toUpperCase();
	const keys = { atlas_capital: UPPER, x_spine_depends_on: [UPPER, ARGYNVOST] };
	const world = () => [
		upsert(VALLAKI, "Vallaki", 1),
		upsert(ARGYNVOST, "Argynvostholt", 2),
		upsert(KREZK, "Krezk", 3, { description: "A walled village.", ...keys }),
	];
	const made = await pull(world());
	const first = await note(made, "Krezk");
	// The id-to-name maps match an id as spelled: another spelling is no
	// element they name, so it stays the bare id, never a link.
	assert.ok(first.text.includes(`atlas_capital: ${UPPER}\n`), first.text);
	assert.ok(first.text.includes(`x_spine_depends_on:\n  - ${UPPER}\n  - "[[Argynvostholt]]"\n`), first.text);
	const read = await readElement(made.app, first.file);
	assert.ok(read);
	for (const [k, v] of Object.entries(keys)) assert.deepEqual(read.fields[k], v, k);
	await pull(world(), made);
	assert.equal((await note(made, "Krezk")).text, first.text);
	const r = await harnessSave({
		notes: {
			"Location/Krezk.md": first.text,
			"Location/Vallaki.md": (await note(made, "Vallaki")).text,
			"Location/Argynvostholt.md": (await note(made, "Argynvostholt")).text,
		},
		save: "Location/Krezk.md",
		server: { [KREZK]: { name: "Krezk", description: "A walled village.", ...keys } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent.flatMap((b) => Object.keys(b)).filter((k) => k in keys), [], "the served spelling goes back unchanged");
});
