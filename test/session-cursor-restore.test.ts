/**
 * Round C fix round, item 4 (Kael's c-read, low 4): after a server restore
 * and a Download in the middle of a session, the stored cursor is behind the
 * session's, so the head comparison kept the session on its old cursor and a
 * delete made after the restore never showed: auto-sync would have recreated
 * the element. Now the session remembers the stored cursor it last saw; a
 * stored cursor that differs means a Download ran, and the next read starts
 * from it. Cursors are compared for equality only, never ordered.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDeletedOnServer } from "../sync/deleted-on-server";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";

function feedClient(pages: Record<string, { changes: { id: string; op: string }[]; cursor: string; head: number }>) {
	const calls: string[] = [];
	const headAt = new Map<string, number>();
	return {
		calls,
		pages,
		getWorld: async () => ({ id: WID }),
		changesWalk: async (since?: string) => {
			calls.push(since ?? "epoch");
			// A walk with nothing new answers its own cursor and the head that
			// cursor was handed out at, as keel does (never a lower head).
			const page = pages[since ?? "epoch"] ?? { changes: [], cursor: since ?? "c0", head: headAt.get(since ?? "") ?? 0 };
			headAt.set(page.cursor, Math.max(page.head, headAt.get(page.cursor) ?? 0));
			return page;
		},
	};
}

test("★ a restore then a Download mid-session: the next read starts from Download's cursor and sees the new delete", async () => {
	const host = {
		settings: {
			deletedOnServer: {} as Record<string, string[]>,
			syncCursors: { [WID]: { cursor: "c90", head: 90 } } as Record<string, { cursor: string; head: number }>,
		},
	};
	const client = feedClient({
		c90: { changes: [], cursor: "c100", head: 100 },
		c80: { changes: [{ id: VALLAKI, op: "delete" }], cursor: "c85", head: 85 },
	});
	await readDeletedOnServer(host, client); // the session ends at c100
	host.settings.syncCursors[WID] = { cursor: "c80", head: 80 }; // restored, then a Download
	const view = await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["c90", "c80"]);
	assert.equal(view.known, true);
	assert.ok(view.ids.has(VALLAKI), "the delete after the restore was missed");
});

test("★ a restore to the last Download's exact point (an identical stored cursor): the lower head reads as a rewind, and the read starts again from the stored cursor (Kael's fixes read, low 3)", async () => {
	const host = {
		settings: {
			deletedOnServer: {} as Record<string, string[]>,
			syncCursors: { [WID]: { cursor: "80:x", head: 80 } } as Record<string, { cursor: string; head: number }>,
		},
	};
	const client = feedClient({
		"80:x": { changes: [], cursor: "100:y", head: 100 },
	});
	await readDeletedOnServer(host, client); // the session ends at 100:y
	// Restored to 80 (and downloaded again: the same 80:x); a delete lands at 81.
	client.pages["100:y"] = { changes: [], cursor: "100:y", head: 81 };
	client.pages["80:x"] = { changes: [{ id: VALLAKI, op: "delete" }], cursor: "81:z", head: 81 };
	const view = await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["80:x", "100:y", "80:x"]);
	assert.equal(view.known, true);
	assert.ok(view.ids.has(VALLAKI), "the delete after the restore was missed");
});

test("with no Download since, the session reads on from its own cursor", async () => {
	const host = {
		settings: {
			deletedOnServer: {} as Record<string, string[]>,
			syncCursors: { [WID]: { cursor: "c90", head: 90 } } as Record<string, { cursor: string; head: number }>,
		},
	};
	const client = feedClient({ c90: { changes: [], cursor: "c100", head: 100 } });
	await readDeletedOnServer(host, client);
	await readDeletedOnServer(host, client);
	await readDeletedOnServer(host, client);
	assert.deepEqual(client.calls, ["c90", "c100", "c100"]);
});
