/**
 * Manage fields keeps a section that holds text, whatever the dialog says.
 * The keep set was built from the dialog's choices, computed when it opened,
 * so a section written after that (by another writer, a sync) and left
 * unticked was deleted by the rebuild. And the function read the note twice,
 * building the body from one read and the frontmatter from the other. Now the
 * note as read once, at apply, decides what holds text.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices } from "./support/obsidian-mock";
import { ManageFieldsCommand } from "../Commands/ManageFieldsCommand";
import type { FieldChoice } from "../Modals/ManageFieldsModal";
import { bodyTextFields, fieldToHeading } from "../vault/element-transform";

const W = "OnlyWorlds/Worlds/W";
const PATH = `${W}/Elements/Character/Bob.md`;
const A = "019e0000-0000-7000-8000-0000000000d1";

/** The choices a dialog opened on an empty note would hold: every text field present, none with text. */
function staleChoices(extra: FieldChoice[] = []): FieldChoice[] {
	return [
		...bodyTextFields("character").map((key) => ({
			key,
			label: fieldToHeading(key),
			present: true,
			hasContent: false,
			custom: false,
			where: "body" as const,
			group: "Text",
		})),
		...extra,
	];
}

async function apply(note: string, selected: string[], choices: FieldChoice[]) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	const file = (await vault.seed(PATH, note)) as unknown as TFile;
	__notices.length = 0;
	const cmd = new ManageFieldsCommand(app as App) as unknown as {
		applySelection(f: TFile, c: string, s: Set<string>, ch: FieldChoice[]): Promise<void>;
	};
	await cmd.applySelection(file, "character", new Set(selected), choices);
	return { text: vault.contentAt(PATH) ?? "", app, vault, file, cmd };
}

test("★ Manage fields keeps a text section written after the dialog opened, though the dialog said it was empty and it is not ticked", async () => {
	const note = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### Physicality\n\nTall and weathered, the only copy.\n`;
	const { text } = await apply(note, ["description"], staleChoices());
	assert.match(text, /### Physicality\n\nTall and weathered, the only copy\./, text);
	assert.deepEqual(__notices, []);
});

test("★ Manage fields keeps a custom section with text, unticked, when the dialog's choices are stale", async () => {
	const note = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### Looks\n\nMy only portrait.\n`;
	const stale: FieldChoice = { key: "x_looks", label: "Looks", present: true, hasContent: false, custom: true, where: "body", group: "Custom" };
	for (const choices of [staleChoices([stale]), staleChoices()]) {
		const { text } = await apply(note, ["description"], choices);
		assert.match(text, /### Looks\n\nMy only portrait\./, text);
	}
});

test("Manage fields still removes an empty section that is not ticked, and keeps the ticked ones", async () => {
	const note = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### Physicality\n\n\n### Looks\n\n`;
	const { text } = await apply(note, ["description"], staleChoices());
	assert.match(text, /### Description\n\nA guard\./, text);
	assert.doesNotMatch(text, /### Physicality/, text);
	assert.doesNotMatch(text, /### Looks/, text);
});

test("★ Manage fields builds the whole note from one read of it", async () => {
	const note = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n`;
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	const file = (await vault.seed(PATH, note)) as unknown as TFile;
	const v = app.vault as unknown as { read(f: TFile): Promise<string>; modify(f: TFile, c: string): Promise<void> };
	const read = v.read.bind(app.vault);
	const modify = v.modify.bind(app.vault);
	let readsBeforeWrite = 0;
	let wrote = false;
	v.read = async (f) => {
		if (!wrote) readsBeforeWrite++;
		return read(f);
	};
	v.modify = async (f, c) => {
		wrote = true;
		return modify(f, c);
	};
	const cmd = new ManageFieldsCommand(app as App) as unknown as {
		applySelection(f: TFile, c: string, s: Set<string>, ch: FieldChoice[]): Promise<void>;
	};
	await cmd.applySelection(file, "character", new Set(["description", "physicality"]), staleChoices());
	assert.equal(wrote, true, "the note was not written");
	assert.equal(readsBeforeWrite, 1);
	assert.match(vault.contentAt(PATH) ?? "", /### Physicality\n/);
});
