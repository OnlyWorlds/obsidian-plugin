/**
 * The bytes a save puts on the wire (Seethe's walk of round B, mark 2, h37
 * #6632). Her note's file was byte-unchanged after the save, and the server held
 * the description with its leading and trailing double spaces stripped (CRLF and
 * tabs kept). keel does not trim: a PATCH of "  edge  \n\tsecond line  " comes
 * back byte-equal (Skeld's probe on production, 2026-10-17). So the strip is the
 * plugin's, between the note and the request body. These tests read the REAL
 * request body the v2 client sends, through the mock's requestUrl.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __requests } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2Client } from "../client-v2";

const ID = "019f0000-0000-7000-8000-0000000000c1";
const FM = `---\r\nname: Mark2\r\nid: ${ID}\r\n---\r\n`;

/** Save the note as a new element; return the description the POST carried. */
async function sentDescription(content: string): Promise<unknown> {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const file = (await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Mark2.md", content)) as unknown as TFile;
	setRequestUrl((r) => (r.method === "GET" ? { status: 404, json: { error: { code: "not_found", message: "nope" } } } : { status: 201, json: {} }));
	const plugin = { settings: { apiKey: "" }, buildV2Client: async () => new V2Client("ow_k_test", "1234") };
	const result = await new SaveElementCommand(app as App, plugin as never).execute(file, { manual: true });
	assert.equal(result.ok, true, JSON.stringify(result));
	const post = __requests.find((r) => r.method === "POST");
	assert.ok(post?.body, "no POST was sent");
	assert.equal(vault.contentAt(file.path), content, "the save rewrote the note");
	return (JSON.parse(post.body) as Record<string, unknown>).description;
}

test("★ mark 2: a note with no field headings sends its body as the description, edge spaces included (Seethe's CRLF fixture)", async () => {
	const value = "  leading double space\r\n\tthen a tab\r\nnormal\r\n\r\nblank line above\r\nedge trailing  ";
	assert.equal(await sentDescription(`${FM}\r\n${value}\r\n`), value);
});

test("★ the same with LF line endings", async () => {
	const value = "  edge  \n\tsecond line  ";
	assert.equal(await sentDescription(`---\nname: Mark2\nid: ${ID}\n---\n\n${value}\n`), value);
});

test("a ### Description section sends its value with two leading and two trailing spaces", async () => {
	const value = "  edge  \n\tsecond line  ";
	assert.equal(await sentDescription(`---\nname: Mark2\nid: ${ID}\n---\n\n### Description\n\n${value}\n\n### Background\n\n`), value);
});
