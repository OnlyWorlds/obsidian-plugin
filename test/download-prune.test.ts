/**
 * Round C, item 8 (Kael's delta read, low 6): every Download read every note
 * of the world from disk to prune the deleted list, even when the list was
 * empty. It now reads them only when there is something to prune.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";
const KREZK = "019e0000-0000-7000-8000-0000000000a2";

const upsert = (id: string, name: string, seq: number) => ({
	op: "upsert", type: "location", id, change_seq: seq, updated_at: "x", element: { id, name },
});
const del = (id: string, seq: number) => ({ op: "delete", type: "location", id, change_seq: seq, updated_at: "x" });

async function downloadCountingPrunes(changes: unknown[]) {
	const { app } = makeApp();
	const plugin = { settings: { syncCursors: {} as Record<string, unknown>, deletedOnServer: {} as Record<string, string[]> }, saveSettings: async () => {} };
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: "c9", has_more: false, head: 9, changes } };
		return { status: 404, json: {} };
	});
	const cmd = new DownloadWorldCommand(app, { version: "t" }, plugin as never);
	let prunes = 0;
	const own = cmd as unknown as { localElementIds(w: string): Promise<{ own: Set<string>; all: Set<string> }> };
	const real = own.localElementIds.bind(cmd);
	own.localElementIds = async (w: string) => {
		prunes++;
		return real(w);
	};
	await cmd.downloadWithKey("ow_k_test", "1234");
	return { prunes, list: plugin.settings.deletedOnServer[WID] };
}

test("★ a Download with nothing deleted reads no note to prune the list", async () => {
	const r = await downloadCountingPrunes([upsert(VALLAKI, "Vallaki", 1), upsert(KREZK, "Krezk", 2)]);
	assert.equal(r.prunes, 0);
	assert.deepEqual(r.list, []);
});

test("a Download with a delete still prunes to the ids that have a note", async () => {
	const r = await downloadCountingPrunes([upsert(KREZK, "Krezk", 1), upsert(VALLAKI, "Vallaki", 2), del(VALLAKI, 3)]);
	assert.equal(r.prunes, 1);
	assert.deepEqual(r.list, []);
});
