/**
 * Round C, item 4: a frontmatter key one slip from a link field (`friend` for
 * `friends`) is no field of the type, so it is sent as `x_friend`, and that
 * happened without a word. Now the save names the likely field: "friend is
 * not a field of Character; did you mean friends? Sent as x_friend." Nothing
 * is corrected. A slip is the same name in another case, one edit (an
 * insertion, deletion, substitution or swap of neighbours), or a plural or
 * singular slip.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { readElement } from "../vault/element-file";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000e1";
const KOLYAN = "0199c000-0000-7000-8000-0000000000e2";

const note = (fm: string) => `---\nname: Ireena\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;

async function slipsOf(fm: string): Promise<unknown> {
	const { app, vault } = makeApp();
	const f = await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Ireena.md", note(fm));
	const parsed = await readElement(app, f as unknown as TFile);
	return (parsed as unknown as { likelyMisnamed?: unknown }).likelyMisnamed ?? [];
}

test("★ the slips a link field can take are named, each with the field it likely meant", async () => {
	for (const [key, field] of [
		["friend", "friends"],
		["freinds", "friends"],
		["Rivals", "rivals"],
		["birthplac", "birthplace"],
		["ability", "abilities"],
		["languagess", "languages"],
	]) {
		assert.deepEqual(await slipsOf(`${key}: x\n`), [{ key, field }], key);
	}
});

test("a key that is no slip for a link field is not named (a custom field, a synonym)", async () => {
	for (const key of ["mood", "allies", "x_friend", "nickname"]) {
		assert.deepEqual(await slipsOf(`${key}: x\n`), [], key);
	}
});

test("★ Save names the likely field and still sends the key as x_, uncorrected", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": note('friend: "[[Kolyan]]"\n'),
			"Character/Kolyan.md": `---\nname: Kolyan\nid: ${KOLYAN}\n---\n`,
		},
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." }, [KOLYAN]: { name: "Kolyan" } },
	});
	assert.ok(
		r.notices.includes("friend is not a field of Character; did you mean friends? Sent as x_friend."),
		r.notices.join(" | ")
	);
	assert.equal(r.sent.length, 1);
	assert.equal(r.sent[0].x_friend, "[[Kolyan]]");
	assert.equal("friends" in r.sent[0], false, "the key was corrected");
});

test("auto-sync names it once a session per note and key, not at every pause", async () => {
	const notes = { "Character/Ireena.md": note("rival: x\n") };
	const server = { [ID]: { name: "Ireena", description: "A noble." } };
	const once = /rival is not a field of Character; did you mean rivals\?/;
	const first = await harnessSave({ notes, save: "Character/Ireena.md", server, manual: false });
	assert.ok(first.notices.some((n) => once.test(n)), first.notices.join(" | "));
	const second = await harnessSave({ notes, save: "Character/Ireena.md", server, manual: false });
	assert.ok(!second.notices.some((n) => once.test(n)), "named again at the next pause");
});
