/**
 * #2443: a Save reads the note, then waits (the PIN, the client), then reads the change number it sends as If-Match. A pull that
 * writes the note in that wait records a newer number; the save would pair the text it read before the pull with the pull's number,
 * pass the If-Match, and put the old text over what the pull brought. A save whose note changed since it was read sends nothing.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000d1";
const SEQ_FILE = "OnlyWorlds/Worlds/W/.ow-seq.json";
const note = (text: string) => `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\n${text}\n`;
const NOTE = "Character/Ireena.md";
const pullLands = async ({ app, vault, files }: { app: never; vault: { dotfiles: Map<string, string> }; files: Record<string, unknown> }) => {
	await (app as { vault: { modify(f: unknown, t: string): Promise<void> } }).vault.modify(files[NOTE], note("new prose from the world"));
	vault.dotfiles.set(SEQ_FILE, JSON.stringify({ [ID]: 6 }));
};

test("★ a pull that lands while the save waits for its client: nothing is sent, and the note says why (red on 3.23.1: the old text went over the pull's)", async () => {
	const r = await harnessSave({
		notes: { [NOTE]: note("old prose"), "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) },
		save: NOTE,
		server: { [ID]: { name: "Ireena", description: "new prose from the world", change_seq: 6 } },
		beforeClient: pullLands as never,
	});
	assert.equal(r.sent.length, 0, "the old text was sent: " + JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /not saved: the note changed while it was being saved\. Nothing was sent\./.test(n)), r.notices.join(" | "));
	assert.ok((await r.vault.read(r.files[NOTE] as never)).includes("new prose from the world"), "the pull's text stays in the note");
});

test("the same wait in auto-sync: nothing is sent, no notice, the result is local (idle), not an error", async () => {
	const r = await harnessSave({
		notes: { [NOTE]: note("old prose"), "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) },
		save: NOTE,
		manual: false,
		server: { [ID]: { name: "Ireena", description: "new prose from the world", change_seq: 6 } },
		beforeClient: pullLands as never,
	});
	assert.equal(r.sent.length, 0);
	assert.equal(r.notices.length, 0, r.notices.join(" | "));
	assert.deepEqual(r.result.ok, false);
	assert.equal((r.result as { local?: boolean }).local, true);
});

test("the control: no pull in the wait, the edited note is saved", async () => {
	const r = await harnessSave({
		notes: { [NOTE]: note("my edit"), "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) },
		save: NOTE,
		server: { [ID]: { name: "Ireena", description: "old prose", change_seq: 5 } },
		beforeClient: async () => {},
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].description, "my edit");
});
