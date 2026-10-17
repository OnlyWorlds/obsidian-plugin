/**
 * Round C, items 7 and 9: the session's read of the change feed.
 *
 * 7 (Kael's delta read, low 4): two first saves at once on a device with no
 * stored cursor each walked the whole feed; they now share one walk per world.
 *
 * 9: after a Download in the middle of a session, the session's own cursor is
 * behind Download's; the next read starts from the later of the two.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDeletedOnServer } from "../sync/deleted-on-server";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";

function feedClient(pages: Record<string, { changes: { id: string; op: string }[]; cursor: string; head: number }>) {
	const calls: string[] = [];
	return {
		calls,
		getWorld: async () => ({ id: WID }),
		changesWalk: async (since?: string) => {
			calls.push(since ?? "epoch");
			await new Promise((r) => setTimeout(r, 5));
			return pages[since ?? "epoch"] ?? { changes: [], cursor: since ?? "c0", head: 0 };
		},
	};
}

test("★ two reads at once on a device with no cursor share one walk of the feed, and both see the delete", async () => {
	const host = { settings: { deletedOnServer: {}, syncCursors: {} } };
	const client = feedClient({ epoch: { changes: [{ id: VALLAKI, op: "delete" }], cursor: "c3", head: 3 } });
	const [a, b] = await Promise.all([readDeletedOnServer(host, client), readDeletedOnServer(host, client)]);
	assert.deepEqual(client.calls, ["epoch"]);
	assert.ok(a.ids.has(VALLAKI) && b.ids.has(VALLAKI));
	assert.notEqual(a.ids, b.ids, "the two callers share one Set");
});

test("a read after the shared one has settled walks on from where it ended", async () => {
	const host = { settings: { deletedOnServer: {}, syncCursors: {} } };
	const client = feedClient({ epoch: { changes: [], cursor: "c3", head: 3 } });
	await Promise.all([readDeletedOnServer(host, client), readDeletedOnServer(host, client)]);
	await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["epoch", "c3"]);
});

test("★ after a Download mid-session, the next read starts from Download's later cursor, not the session's", async () => {
	const host = { settings: { deletedOnServer: {} as Record<string, string[]>, syncCursors: { [WID]: { cursor: "c5", head: 5 } } as Record<string, { cursor: string; head: number }> } };
	const client = feedClient({
		c5: { changes: [], cursor: "c6", head: 6 },
		c9: { changes: [], cursor: "c10", head: 10 },
	});
	await readDeletedOnServer(host, client);
	host.settings.syncCursors[WID] = { cursor: "c9", head: 9 }; // a Download ran
	await readDeletedOnServer(host, client);
	await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["c5", "c9", "c10"]);
});

test("a session ahead of Download's cursor reads on from its own", async () => {
	const host = { settings: { deletedOnServer: {} as Record<string, string[]>, syncCursors: { [WID]: { cursor: "c5", head: 5 } } } };
	const client = feedClient({ c5: { changes: [], cursor: "c7", head: 7 } });
	await readDeletedOnServer(host, client);
	await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["c5", "c7"]);
});
