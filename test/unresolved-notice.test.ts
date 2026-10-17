/**
 * Round C, item 10: the notice for a [[link]] no element id answers said the
 * element was "not on the server yet" and to run "Export World". A link to a
 * note that is not on the server is created first by Save Element now, and
 * Upload World resolves links the same way a save does, so uploading never
 * helps here. The notice names the real fix: a name no note carries, or a
 * note this field cannot link.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000e1";
const KREZK = "0199c000-0000-7000-8000-0000000000e2";

test("★ the unresolved-link notice names the fix, never Export World or Upload World", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": `---\nname: Ireena\nid: ${ID}\nbirthplace: "[[Nowhere]]"\nlocation: "[[Krezk]]"\n---\n\n### Description\n\nA noble.\n`,
			"Character/Krezk.md": `---\nname: Krezk\nid: ${KREZK}\n---\n`,
		},
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	const n = r.notices.find((x) => x.startsWith("Not saved to those links")) ?? "";
	assert.ok(n, r.notices.join(" | "));
	assert.doesNotMatch(n, /Export World|Upload World/);
	assert.match(n, /No note in this world is named Nowhere: create it or correct the link\./);
	assert.match(n, /Krezk has a note with no element id yet, or of another type than the field takes\./);
});
