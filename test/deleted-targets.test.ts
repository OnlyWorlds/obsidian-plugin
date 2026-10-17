/**
 * An element deleted on onlyworlds.com is never recreated by a save (Kael's
 * cold read, blocker 1c, OW Infra #166 row 8). Download keeps a deleted
 * element's note on purpose ("Notes are never auto-deleted"), so a note can
 * still link to it, and a GET answers 404 for "deleted" exactly as for "not
 * pushed yet". Download now keeps the ids the change feed reported deleted,
 * per world, in the plugin's data; the manual Save's create-first walk leaves
 * them out and says so.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __notices, __modals } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2ApiError } from "../client-v2";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const IREENA = "019e0000-0000-7000-8000-0000000000c1";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";
const KREZK = "019e0000-0000-7000-8000-0000000000a2";

type Settings = { syncCursors: Record<string, unknown>; deletedOnServer?: Record<string, string[]> };

async function download(app: App, plugin: { settings: Settings; saveSettings(): Promise<void> }, changes: unknown[], head: number) {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes } };
		return { status: 404, json: {} };
	});
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
}

const upsert = (id: string, name: string, seq: number) => ({
	op: "upsert", type: "location", id, change_seq: seq, updated_at: "x", element: { id, name },
});
const del = (id: string, seq: number) => ({ op: "delete", type: "location", id, change_seq: seq, updated_at: "x" });

test("★ Download keeps the ids the change feed reported deleted, per world; a later upsert of the id clears it", async () => {
	const { app } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 1), upsert(KREZK, "Krezk", 2), del(VALLAKI, 3)], 3);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [VALLAKI]);
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 4), del(KREZK, 5)], 5);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [KREZK]);
});

const note = (id: string, name: string, links = "") =>
	`---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nAbout ${name}.\n`;

async function manualSave(deleted: string[], notes: Record<string, string>, answer = true) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const files: Record<string, TFile> = {};
	for (const [rel, c] of Object.entries(notes)) files[rel] = (await vault.seed(`OnlyWorlds/Worlds/W/Elements/${rel}`, c)) as unknown as TFile;
	const bulks: string[][] = [];
	const client = {
		getWorld: async () => ({ id: WID, name: "W" }),
		get: async () => {
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		create: async (_t: string, b: Record<string, unknown>) => {
			if (b.birthplace) throw new V2ApiError(400, "invalid_link", "birthplace references Location which does not exist.", null);
			return b;
		},
		update: async () => ({}),
		bulkCreate: async (items: { type: string; element: Record<string, unknown> }[]) => {
			bulks.push(items.map((i) => String(i.element.id)));
			return { errors: false, items: items.map((i) => ({ status: 201, id: i.element.id })) };
		},
	};
	const plugin = { settings: { apiKey: "", deletedOnServer: { [WID]: deleted } }, buildV2Client: async () => client };
	__notices.length = 0;
	__modals.length = 0;
	const dialogs: { items: unknown[]; leftOut: unknown[]; choose(b: boolean): void }[] = [];
	let done = false;
	const run = new SaveElementCommand(app, plugin as never).execute(files["Character/Ireena.md"], { manual: true }).finally(() => (done = true));
	while (!done) {
		await new Promise((r) => setImmediate(r));
		for (const m of __modals.splice(0)) {
			const d = m as unknown as (typeof dialogs)[number];
			if (typeof d.choose !== "function") continue;
			dialogs.push(d);
			d.choose(answer);
		}
	}
	return { result: await run, bulks, dialogs, notices: [...__notices] };
}

test("★ a target the change feed reported deleted is never recreated; the dialog says it is left out", async () => {
	const r = await manualSave([VALLAKI], {
		"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\nlocation: "[[Krezk]]"\n'),
		"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
		"Location/Krezk.md": note(KREZK, "Krezk"),
	});
	assert.equal(r.dialogs.length, 1);
	assert.deepEqual(r.dialogs[0].items, [{ type: "location", name: "Krezk" }]);
	assert.deepEqual(r.dialogs[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	for (const b of r.bulks) assert.ok(!b.includes(VALLAKI), "a deleted element was recreated");
});

test("★ the only target deleted: no dialog, nothing recreated, the notice names it", async () => {
	const r = await manualSave([VALLAKI], {
		"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
	});
	assert.equal(r.dialogs.length, 0);
	assert.deepEqual(r.bulks, []);
	assert.ok(
		r.notices.some((n) => n.includes('Location "Vallaki" was deleted on onlyworlds.com and is left out.')),
		r.notices.join(" | ")
	);
});
