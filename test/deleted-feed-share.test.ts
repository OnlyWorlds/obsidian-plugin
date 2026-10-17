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
