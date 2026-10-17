/**
 * Upload World never recreates an element deleted on onlyworlds.com without
 * the user's word (Kael's second read, N4). Download keeps a deleted element's
 * note on purpose, and the sweep's own change-feed walk sees the delete, yet
 * the id went into the create list. Now those ids are left out and named, with
 * a "create them again?" choice; the same deleted list the save uses is
 * consulted and kept.
 *
 * Run against the REAL ExportWorldCommand (collect + upload) through the
 * in-memory vault, the v2 client's network methods stubbed on its prototype.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices, __modals } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { V2Client } from "../client-v2";

const W = "OnlyWorlds/Worlds/W";
const WID = "019a0000-0000-7000-8000-0000000000ee";
const IDS = {
	Akragas: "019a0000-0000-7000-8000-0000000000c1",
	Gela: "019a0000-0000-7000-8000-0000000000c2",
	Syracuse: "019a0000-0000-7000-8000-0000000000c3",
};
const note = (id: string, name: string, links = "") => `---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nA city.\n`;

type Proto = Record<string, unknown>;
const proto = V2Client.prototype as unknown as Proto;
const saved: Proto = {};
for (const k of ["changesWalk", "bulkCreate", "update", "getWorld", "patchWorld"]) saved[k] = proto[k];

interface Dialog {
	title: string;
	lines: string[];
	choose(yes: boolean): void;
}

/** Upload W, where the feed says Akragas exists and Gela was deleted; Syracuse is new. */
async function upload(opts: { answer: boolean; deleted?: string[]; links?: Record<string, string> }) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	for (const [name, id] of Object.entries(IDS)) await vault.seed(`${W}/Elements/Location/${name}.md`, note(id, name, opts.links?.[name] ?? ""));
	const created: string[] = [];
	const bulkSent: Record<string, unknown>[] = [];
	const patches: Record<string, Record<string, unknown>> = {};
	proto.getWorld = async () => ({ id: WID, name: "W" });
	proto.changesWalk = async () => ({
		changes: [
			{ op: "upsert", type: "location", id: IDS.Akragas, change_seq: 1 },
			{ op: "upsert", type: "location", id: IDS.Gela, change_seq: 2 },
			{ op: "delete", type: "location", id: IDS.Gela, change_seq: 3 },
		],
		cursor: "c3",
		head: 3,
	});
	proto.bulkCreate = async (items: { element: { id: string } }[]) => {
		created.push(...items.map((i) => i.element.id));
		bulkSent.push(...items.map((i) => i.element as Record<string, unknown>));
		return { errors: false, items: items.map((i) => ({ status: 201, id: i.element.id })) };
	};
	proto.update = async (_t: string, id: string, b: Record<string, unknown>) => {
		patches[id] = b;
		return {};
	};
	proto.patchWorld = async () => ({});
	const plugin = {
		settings: { apiKey: "", deletedOnServer: { [WID]: opts.deleted ?? [] } as Record<string, string[]>, syncCursors: {} },
		saveSettings: async () => {},
		pinCache: { get: async () => null },
	};
	const cmd = new ExportWorldCommand(app, {} as never, new WorldService(app), plugin as never);
	const data = await cmd.collectWorldData("W");
	__notices.length = 0;
	__modals.length = 0;
	const dialogs: Dialog[] = [];
	let done = false;
	try {
		const run = (cmd as unknown as { uploadViaV2(pin: number, w: string, d: unknown): Promise<void> })
			.uploadViaV2(1234, "W", data)
			.finally(() => (done = true));
		while (!done) {
			await new Promise((r) => setImmediate(r));
			for (const m of __modals.splice(0)) {
				const d = m as unknown as Dialog;
				if (typeof d.choose !== "function") continue;
				dialogs.push(d);
				d.choose(opts.answer);
			}
		}
		await run;
	} finally {
		for (const [k, v] of Object.entries(saved)) proto[k] = v;
	}
	return { created, bulkSent, patches, dialogs, notices: [...__notices], settings: plugin.settings };
}

test("★ an element the feed reports deleted is not recreated: asked, left out on 'Leave out', named in the summary", async () => {
	const r = await upload({ answer: false });
	assert.equal(r.dialogs.length, 1, "no create-again dialog");
	assert.match(r.dialogs[0].title, /deleted on onlyworlds\.com: create (it|them) again\?/i);
	assert.ok(r.dialogs[0].lines.some((l) => l.includes('Location "Gela"')), r.dialogs[0].lines.join(" | "));
	assert.deepEqual(r.created, [IDS.Syracuse], "Gela was recreated");
	const summary = r.notices.find((n) => n.startsWith("Upload complete")) ?? "";
	assert.match(summary, /1 created/);
	assert.ok(r.notices.some((n) => /left out/i.test(n) && /Gela/.test(n)), r.notices.join(" | "));
	assert.deepEqual(r.settings.deletedOnServer[WID], [IDS.Gela], "the list did not keep the delete");
});

test("Create again sends it with the new ones and takes it off the deleted list", async () => {
	const r = await upload({ answer: true, deleted: [IDS.Gela] });
	assert.equal(r.dialogs.length, 1);
	assert.deepEqual([...r.created].sort(), [IDS.Gela, IDS.Syracuse].sort());
	assert.deepEqual(r.settings.deletedOnServer[WID], []);
});

test("★ the list Upload World keeps holds only ids with a local note (Kael's third read, 4)", async () => {
	const NOTELESS = "019a0000-0000-7000-8000-0000000000f9";
	const r = await upload({ answer: false, deleted: [NOTELESS] });
	assert.deepEqual(r.settings.deletedOnServer[WID], [IDS.Gela]);
});

// --- Kael's third read, 1: Leave out never sinks the notes that link it -----

test("★ Leave out takes the left-out id out of every note's links, new and existing alike, and the summary says so", async () => {
	const r = await upload({
		answer: false,
		links: { Akragas: 'rival: "[[Gela]]"\n', Syracuse: 'partner: "[[Gela]]"\n' },
	});
	const syracuse = r.bulkSent.find((e) => e.id === IDS.Syracuse);
	assert.ok(syracuse, "Syracuse was not sent");
	assert.equal("partner" in syracuse, false, "the new note still links the left-out element");
	assert.ok(r.patches[IDS.Akragas], "Akragas was not updated");
	assert.equal("rival" in r.patches[IDS.Akragas], false, "the existing note still links the left-out element");
	assert.ok(r.notices.some((n) => /links to Location "Gela" left out of 2 notes/i.test(n)), r.notices.join(" | "));
});

test("Create again keeps those links: the element comes back with them", async () => {
	const r = await upload({ answer: true, links: { Akragas: 'rival: "[[Gela]]"\n' } });
	assert.equal(r.patches[IDS.Akragas]?.rival, IDS.Gela);
});
