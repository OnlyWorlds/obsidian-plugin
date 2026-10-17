/**
 * A note is never refused for linking to a sibling note the plugin could
 * create (OW Infra #166 row 8, hop 10 live part 1): keel 400s a write whose
 * link names an element it does not have ("location references Location ...
 * which does not exist"), and a vault of new notes linking among themselves
 * failed note by note until the targets happened to save first.
 *
 * Now a save first finds the link targets that are local notes without a
 * server element (depth-first, a visited set), and sends them with the note in
 * one POST /bulk, which keel validates against the batch and applies in one
 * transaction, cycles included (keel elements/bulk.py, the two-phase law). The
 * notice names what it created first. Run against the REAL SaveElementCommand
 * through the in-memory vault, with a recording fake of the v2 client.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices, __modals } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2ApiError } from "../client-v2";

/** The create-first dialog, as the test drives it. */
interface Dialog {
	items: { type: string; name: string }[];
	leftOut: { type: string; name: string }[];
	choose(create: boolean): void;
}

const W = "OnlyWorlds/Worlds/W";
const ID = {
	ireena: "019b0000-0000-7000-8000-0000000000c1",
	vallaki: "019b0000-0000-7000-8000-0000000000a1",
	barovia: "019b0000-0000-7000-8000-0000000000a2",
	krezk: "019b0000-0000-7000-8000-0000000000a3",
	brave: "019b0000-0000-7000-8000-0000000000b1",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const note = (id: string, name: string, links = "") =>
	`---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nAbout ${name}.\n`;

interface Opts {
	existing?: Iterable<string>;
	/** /bulk answers this status for these ids (default 201 for every item). */
	bulkStatus?: Record<string, number>;
	current?: Record<string, Record<string, unknown>>;
}

async function harness(notes: Record<string, string>, opts: Opts = {}) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "- **API Key:** ow_k_test\n");
	const files: Record<string, TFile> = {};
	for (const [rel, content] of Object.entries(notes)) {
		files[rel] = (await vault.seed(`${W}/Elements/${rel}`, content)) as unknown as TFile;
	}
	const existing = new Set(opts.existing ?? []);
	const calls: string[] = [];
	const bulks: { type: string; element: Record<string, unknown> }[][] = [];
	/** keel's answer to a write linking an element it does not have (elements/resolve.py InvalidLink). */
	const refuseMissingLinks = (body: Record<string, unknown>) => {
		for (const [k, v] of Object.entries(body)) {
			if (k === "id") continue;
			for (const x of Array.isArray(v) ? v : [v]) {
				if (typeof x === "string" && UUID.test(x) && !existing.has(x)) {
					throw new V2ApiError(400, "invalid_link", `${k} references Location '${x}' which does not exist.`, null);
				}
			}
		}
	};
	const client = {
		// No stored cursor in this harness: "never downloaded here".
		getWorld: async () => ({ id: "019b0000-0000-7000-8000-0000000000ee" }),
		get: async (type: string, id: string) => {
			calls.push(`get ${type} ${id}`);
			if (existing.has(id)) return { id, name: "server", ...(opts.current?.[id] ?? {}) };
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		create: async (type: string, body: Record<string, unknown>) => {
			calls.push(`create ${type} ${String(body.id)}`);
			refuseMissingLinks(body);
			existing.add(String(body.id));
			return body;
		},
		update: async (type: string, id: string, body: Record<string, unknown>) => {
			calls.push(`update ${type} ${id} ${JSON.stringify(body)}`);
			refuseMissingLinks(body);
			return {};
		},
		bulkCreate: async (items: { type: string; element: Record<string, unknown> }[]) => {
			calls.push(`bulk ${items.map((i) => `${i.type}:${String(i.element.id)}`).join(",")}`);
			bulks.push(items);
			const results = items.map((i) => {
				const status = opts.bulkStatus?.[String(i.element.id)] ?? 201;
				if (status === 201) existing.add(String(i.element.id));
				return status === 201
					? { status, id: i.element.id }
					: { status, id: i.element.id, error: { message: "references Location which does not exist" } };
			});
			return { errors: results.some((r) => r.status !== 201), items: results };
		},
	};
	const plugin = {
		settings: { apiKey: "" },
		buildV2Client: async () => client,
	};
	const cmd = new SaveElementCommand(app as App, plugin as never);
	__notices.length = 0;
	/**
	 * The manual Save Element (`manual`), or auto-sync's save of the same note.
	 * Every create-first dialog that opens is answered with `answer` and kept
	 * in `dialogs`.
	 */
	const dialogs: Dialog[] = [];
	const save = async (file: TFile, manual = true, answer = true) => {
		__modals.length = 0;
		let done = false;
		const run = cmd.execute(file, { manual }).finally(() => (done = true));
		while (!done) {
			await new Promise((r) => setImmediate(r));
			for (const m of __modals.splice(0)) {
				// The own-create confirm a never-downloaded device shows: always Create here.
				if (m.constructor.name === "ConfirmModal") {
					(m as unknown as Dialog).choose(true);
					continue;
				}
				if (m.constructor.name !== "CreateFirstModal") continue;
				const d = m as unknown as Dialog;
				dialogs.push(d);
				d.choose(answer);
			}
		}
		return run;
	};
	return { app, vault, files, cmd, save, dialogs, calls, bulks, notices: __notices };
}

test("★ row 8: a new note linking to a new local note creates the target first, in one /bulk", async () => {
	const h = await harness({
		"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(ID.vallaki, "Vallaki"),
	});
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.deepEqual(result, { ok: true, outcome: "created" });
	assert.ok(!h.calls.some((c) => c.startsWith("create ")), "a lone create would be refused by keel");
	assert.deepEqual(h.calls.filter((c) => c.startsWith("bulk")), [
		`bulk location:${ID.vallaki},character:${ID.ireena}`,
	]);
	const ireena = h.bulks[0][1].element;
	assert.equal(ireena.birthplace, ID.vallaki, "the link travels with the note");
	assert.ok(h.notices.some((n) => n.includes('Created Location "Vallaki" first')), h.notices.join(" | "));
});

test("★ row 8: a chain is created depth-first, targets before the notes that link to them", async () => {
	const h = await harness({
		"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(ID.vallaki, "Vallaki", 'parent_location: "[[Barovia]]"\n'),
		"Location/Barovia.md": note(ID.barovia, "Barovia"),
	});
	await h.save(h.files["Character/Ireena.md"]);
	assert.deepEqual(h.bulks[0].map((i) => i.element.id), [ID.barovia, ID.vallaki, ID.ireena]);
});

test("★ row 8: cycles (a target linking back to the note, two targets linking to each other) end, and go in the one batch", async () => {
	const h = await harness({
		"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(ID.vallaki, "Vallaki", 'rival: "[[Krezk]]"\nfounders:\n  - "[[Ireena]]"\n'),
		"Location/Krezk.md": note(ID.krezk, "Krezk", 'rival: "[[Vallaki]]"\n'),
	});
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, true);
	assert.equal(h.bulks.length, 1);
	const ids = h.bulks[0].map((i) => i.element.id);
	assert.deepEqual([...ids].sort(), [ID.ireena, ID.krezk, ID.vallaki].sort());
	assert.equal(ids.at(-1), ID.ireena, "the note itself goes last");
	const vallaki = h.bulks[0].find((i) => i.element.id === ID.vallaki)!.element;
	assert.equal(vallaki.rival, ID.krezk, "a link inside the cycle is sent, not left bare");
	assert.deepEqual(vallaki.founders, [ID.ireena]);
});

test("row 8: a target already on the server stops the walk; a note with no new targets creates as before", async () => {
	const h = await harness(
		{
			"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
			"Location/Vallaki.md": note(ID.vallaki, "Vallaki", 'parent_location: "[[Barovia]]"\n'),
			"Location/Barovia.md": note(ID.barovia, "Barovia"),
		},
		{ existing: [ID.vallaki] }
	);
	await h.save(h.files["Character/Ireena.md"]);
	assert.deepEqual(h.calls, [`get character ${ID.ireena}`, `get location ${ID.vallaki}`, `create character ${ID.ireena}`]);
});

test("★ row 8: an existing note given a link to a new local note creates the target first, then saves", async () => {
	const h = await harness(
		{
			"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\ntraits:\n  - "[[Brave]]"\n'),
			"Location/Vallaki.md": note(ID.vallaki, "Vallaki"),
			"Trait/Brave.md": note(ID.brave, "Brave"),
		},
		{ existing: [ID.ireena, ID.brave], current: { [ID.ireena]: { name: "Ireena", birthplace: null, traits: [ID.brave] } } }
	);
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.deepEqual(result, { ok: true, outcome: "updated" });
	const bulkAt = h.calls.findIndex((c) => c.startsWith("bulk"));
	const updateAt = h.calls.findIndex((c) => c.startsWith("update"));
	assert.equal(h.calls[bulkAt], `bulk location:${ID.vallaki}`, "only the new target, not Brave (already on the server)");
	assert.ok(bulkAt >= 0 && updateAt > bulkAt, h.calls.join(" | "));
	assert.ok(!h.calls.includes(`get trait ${ID.brave}`), "an unchanged link is not looked up");
	assert.ok(h.notices.some((n) => n.includes('Created Location "Vallaki" first')));
});

test("row 8: a target keel refuses fails the save, names it, and sends nothing more", async () => {
	const h = await harness(
		{
			"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
			"Location/Vallaki.md": note(ID.vallaki, "Vallaki"),
		},
		{ bulkStatus: { [ID.vallaki]: 422, [ID.ireena]: 400 } }
	);
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, false);
	assert.match((result as { reason: string }).reason, /Vallaki/);
	assert.ok(!h.calls.some((c) => c.startsWith("create ") || c.startsWith("update ")));
});

// --- Kael's read, blocker (a): the walk runs only from the manual Save --------

test("★ auto-sync never runs the create-first walk: keel's refusal stands, and the notice says Save Element creates them first", async () => {
	const h = await harness({
		"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(ID.vallaki, "Vallaki"),
	});
	const result = await h.save(h.files["Character/Ireena.md"], false);
	assert.equal(result.ok, false);
	assert.deepEqual(h.bulks, [], "auto-sync created something");
	assert.ok(!h.calls.includes(`get location ${ID.vallaki}`), "auto-sync walked the links");
	assert.match((result as { reason: string }).reason, /Save Element creates them first/);
});

test("auto-sync on an existing note given a link to a new note: refused, nothing created", async () => {
	const h = await harness(
		{
			"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
			"Location/Vallaki.md": note(ID.vallaki, "Vallaki"),
		},
		{ existing: [ID.ireena], current: { [ID.ireena]: { name: "Ireena", birthplace: null } } }
	);
	const result = await h.save(h.files["Character/Ireena.md"], false);
	assert.equal(result.ok, false);
	assert.deepEqual(h.bulks, []);
	assert.match((result as { reason: string }).reason, /Save Element creates them first/);
});

// --- Kael's read, blocker (b): a manual Save confirms what it creates first ---

const CHAIN = {
	"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
	"Location/Vallaki.md": note(ID.vallaki, "Vallaki", 'parent_location: "[[Barovia]]"\n'),
	"Location/Barovia.md": note(ID.barovia, "Barovia"),
};

test("★ a manual Save shows what it would create first, type and name each, before anything is sent", async () => {
	const h = await harness(CHAIN);
	await h.save(h.files["Character/Ireena.md"]);
	assert.equal(h.dialogs.length, 1, "no confirm dialog");
	assert.deepEqual(h.dialogs[0].items, [
		{ type: "location", name: "Barovia" },
		{ type: "location", name: "Vallaki" },
	]);
	assert.equal(h.bulks.length, 1, "Create sends the batch");
});

test("★ Cancel in the dialog creates nothing and saves nothing", async () => {
	const h = await harness(CHAIN);
	const result = await h.save(h.files["Character/Ireena.md"], true, false);
	assert.equal(h.dialogs.length, 1);
	assert.equal(result.ok, false);
	assert.match((result as { reason: string }).reason, /cancelled/i);
	assert.deepEqual(h.bulks, []);
	assert.ok(!h.calls.some((c) => c.startsWith("create ") || c.startsWith("update ")), h.calls.join(" | "));
});

test("Cancel on an existing note's save: nothing created, no PATCH", async () => {
	const h = await harness(
		{ "Character/Ireena.md": CHAIN["Character/Ireena.md"], "Location/Vallaki.md": note(ID.vallaki, "Vallaki") },
		{ existing: [ID.ireena], current: { [ID.ireena]: { name: "Ireena", birthplace: null } } }
	);
	const result = await h.save(h.files["Character/Ireena.md"], true, false);
	assert.equal(result.ok, false);
	assert.deepEqual(h.bulks, []);
	assert.ok(!h.calls.some((c) => c.startsWith("update ")));
});

test("no dialog when there is nothing to create first", async () => {
	const h = await harness({ "Character/Ireena.md": note(ID.ireena, "Ireena") });
	await h.save(h.files["Character/Ireena.md"]);
	assert.equal(h.dialogs.length, 0);
	assert.ok(h.calls.includes(`create character ${ID.ireena}`));
});

// --- Kael's read, should-fix 2: the walk stops at 50 targets ------------------

/** Ireena linking to `n` new trait notes. */
function manyTraits(n: number): Record<string, string> {
	const notes: Record<string, string> = {};
	const links: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `019b0000-0000-7000-8000-${String(i).padStart(12, "0")}`;
		notes[`Trait/T${i}.md`] = note(id, `T${i}`);
		links.push(`  - "[[T${i}]]"`);
	}
	notes["Character/Ireena.md"] = note(ID.ireena, "Ireena", `traits:\n${links.join("\n")}\n`);
	return notes;
}

test("★ more than 50 targets to create first: nothing is created, and the notice points to Upload World", async () => {
	const h = await harness(manyTraits(51));
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, false);
	assert.match((result as { reason: string }).reason, /Upload World/);
	assert.equal(h.dialogs.length, 0, "no dialog past the cap");
	assert.deepEqual(h.bulks, []);
	assert.ok(!h.calls.some((c) => c.startsWith("create ") || c.startsWith("update ")));
	assert.ok(h.calls.filter((c) => c.startsWith("get trait")).length <= 51, "the walk ran past the cap");
});

test("exactly 50 targets: the dialog lists all 50 and Create sends them", async () => {
	const h = await harness(manyTraits(50));
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, true);
	assert.equal(h.dialogs[0]?.items.length, 50);
	assert.equal(h.bulks[0].length, 51);
});

/** Ireena -> L0 -> L1 -> ... -> L(n-1), each a new location note (parent_location). */
function chain(n: number): Record<string, string> {
	const notes: Record<string, string> = {
		"Character/Ireena.md": note(ID.ireena, "Ireena", 'birthplace: "[[L0]]"\n'),
	};
	for (let i = 0; i < n; i++) {
		const id = `019b0000-0000-7000-8000-1${String(i).padStart(11, "0")}`;
		notes[`Location/L${i}.md`] = note(id, `L${i}`, i + 1 < n ? `parent_location: "[[L${i + 1}]]"\n` : "");
	}
	return notes;
}

test("★ the cap holds on a chain: 60 notes in a line create nothing, no dialog, and the walk stops at the 51st (Kael's second read, N2)", async () => {
	const h = await harness(chain(60));
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, false);
	assert.match((result as { reason: string }).reason, /Upload World/);
	assert.equal(h.dialogs.length, 0);
	assert.deepEqual(h.bulks, []);
	assert.ok(h.calls.filter((c) => c.startsWith("get location")).length <= 51, "the walk ran past the cap");
});

test("a chain of exactly 50 still goes through the dialog, deepest first", async () => {
	const h = await harness(chain(50));
	const result = await h.save(h.files["Character/Ireena.md"]);
	assert.equal(result.ok, true);
	assert.equal(h.dialogs[0]?.items.length, 50);
	assert.deepEqual(h.dialogs[0]?.items[0], { type: "location", name: "L49" });
});
