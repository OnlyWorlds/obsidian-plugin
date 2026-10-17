/**
 * Round C fix round, item 7 (N8 from Kael's fixes read): a note whose
 * closing `---` line carries a trailing space gave a description starting
 * with that space and a blank line (" \n\nAbout N."), sent as a change. Now
 * the frontmatter fence lines are matched with trailing whitespace allowed,
 * and the body starts at its first byte after that line.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { readElement } from "../vault/element-file";
import { splitNote, parseRawFrontmatterScalars } from "../vault/element-transform";

const ID = "0199c000-0000-7000-8000-0000000000f7";

async function read(content: string) {
	const { app, vault } = makeApp();
	const f = await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/N.md", content);
	return readElement(app, f as unknown as TFile);
}

test("★ a closing `--- ` with a trailing space: the heading-less description starts at its first byte", async () => {
	const parsed = await read(`---\nname: N\nid: ${ID}\n--- \n\nAbout N.\n`);
	assert.ok(parsed);
	assert.equal(parsed.fields.description, "About N.");
});

test("★ a closing `---` with a tab and CRLF: the sections read as written", async () => {
	const parsed = await read(`---\r\nname: N\r\nid: ${ID}\r\n---\t\r\n\r\n### Description\r\n\r\nAbout N.\r\n`);
	assert.ok(parsed);
	assert.equal(parsed.fields.description, "About N.");
});

test("splitNote and the raw scalar reader take the same close", () => {
	const note = `---\nname: N\nid: ${ID}\n---  \n\nBody.\n`;
	assert.deepEqual(splitNote(note), { frontmatter: `---\nname: N\nid: ${ID}\n---`, body: "Body.\n" });
	assert.deepEqual(parseRawFrontmatterScalars(note, ["id"]), { id: ID });
});

test("a `---text` line is no close: the block runs on to the real one", () => {
	const note = `---\nname: N\nnote: x\n---more\nid: ${ID}\n---\n\nBody.\n`;
	assert.deepEqual(parseRawFrontmatterScalars(note, ["id"]), { id: ID });
});
