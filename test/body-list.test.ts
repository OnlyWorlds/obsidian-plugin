/**
 * Round C, item 13 (a README line, pinned here): a list typed in an element
 * note's body is description text, whether `- height: 172` or
 * `- **Height:** 172` (World.md's own shape); only the old `<span>` format is
 * read as fields from a body list. A guard, not a fix: it passes on 3.5.0.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { readElement } from "../vault/element-file";

const ID = "0199c000-0000-7000-8000-0000000000e1";

test("a hand-written body list, plain or bold, is description text and no field", async () => {
	const { app, vault } = makeApp();
	const list = "- height: 172\n- **Weight:** 70";
	const f = await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Character/Ireena.md",
		`---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\n${list}\n`
	);
	const parsed = await readElement(app, f as unknown as TFile);
	assert.equal(parsed?.fields.description, list);
	assert.equal("height" in (parsed?.fields ?? {}), false);
	assert.equal("weight" in (parsed?.fields ?? {}), false);
});

test("the old <span> list is read as fields", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Character/Ireena.md",
		`- <span class="text-field" data-tooltip="Text">Id</span>: ${ID}\n- <span class="text-field" data-tooltip="Text">Name</span>: Ireena\n- <span class="integer" data-tooltip="Number">Height</span>: 172\n`
	);
	const parsed = await readElement(app, f as unknown as TFile);
	assert.equal(parsed?.fields.height, 172);
});
