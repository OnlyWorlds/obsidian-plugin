/**
 * A text field's value round-trips byte for byte (OW Infra #166 row 16, hop 9
 * #11): no trim of leading or trailing whitespace, no line-ending
 * normalisation, on save (readElement), upload (the same read) and folder
 * export. Before, every section was trimmed and CRLF became LF.
 *
 * The body layout is unchanged: `### Heading`, a blank line, the value, a
 * blank line. What changed is the read: it now strips exactly that layout and
 * nothing of the value.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setYamlParser, __modals, type MockVault } from "./support/obsidian-mock";
import { buildElementBody, bodyToFieldValues } from "../vault/element-transform";
import { readElement, writeElement } from "../vault/element-file";
import { ManageFieldsCommand } from "../Commands/ManageFieldsCommand";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";

const ID = "0199c000-0000-7000-8000-0000000000e1";
const WID = "0199c000-0000-7000-8000-0000000000ee";

/** Values a user or another tool can hold: edge whitespace, CRLF, lone CR, blank lines. */
const HARD: Record<string, string> = {
	description: "  Indented first line.\r\nA CRLF line.\n\nTrailing spaces.  ",
	background: "\n\nStarts with two newlines.",
	motivations: "Ends with a newline.\n",
	physicality: " ",
	mentality: "Ends with CRLF.\r\n",
	reputation: "A lone CR\rinside.\t",
};

test("row 16: the body layout reads back every text value exactly (pure)", () => {
	const note = `${buildElementBody(HARD, "character")}\n`; // writeElement's trailing newline
	const back = bodyToFieldValues(note, "character");
	for (const [k, v] of Object.entries(HARD)) assert.equal(back[k], v, k);
});

test("row 16: an empty section still reads as an empty value", () => {
	const note = `${buildElementBody({ description: "Only this." }, "character")}\n`;
	const back = bodyToFieldValues(note, "character");
	assert.equal(back.description, "Only this.");
	assert.equal(back.background, "");
	assert.equal(back.motivations, "");
});

test("row 16: a hand-typed CRLF note reads its values without the layout's line endings", () => {
	const body = "### Description\r\n\r\nTyped on Windows.\r\nSecond line.\r\n\r\n### Background\r\n\r\nMore.\r\n";
	const back = bodyToFieldValues(body, "character");
	assert.equal(back.description, "Typed on Windows.\r\nSecond line.");
	assert.equal(back.background, "More.");
});

async function writeAndRead(app: App, data: Record<string, unknown>) {
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", ...data });
	return readElement(app, file as TFile);
}

for (const parser of ["js-yaml", "yaml"] as const) {
	test(`row 16: save path, writeElement then readElement keeps every text value exactly (${parser})`, async () => {
		setYamlParser(parser);
		try {
			const { app } = makeApp();
			const parsed = await writeAndRead(app, {
				...HARD,
				name: "  Ireena Kolyana ",
				supertype: "noble\r\nborn",
				subtype: " ward ",
			});
			assert.ok(parsed);
			for (const [k, v] of Object.entries(HARD)) assert.equal(parsed.fields[k], v, k);
			assert.equal(parsed.fields.name, "  Ireena Kolyana ");
			assert.equal(parsed.fields.supertype, "noble\r\nborn");
			assert.equal(parsed.fields.subtype, " ward ");
		} finally {
			setYamlParser("js-yaml");
		}
	});
}

test("row 16: a Manage Fields rewrite keeps a value that ends in a newline", async () => {
	const { app, vault } = makeApp();
	const file = (await writeElement(app, "W", "character", ID, { name: "Ireena", description: "Line one.\n" })) as TFile;
	const cmd = new ManageFieldsCommand(app) as unknown as {
		applySelection(f: TFile, c: string, s: Set<string>, ch: { key: string; hasContent: boolean }[]): Promise<void>;
	};
	// Description alone: it becomes the note's last section.
	await cmd.applySelection(file, "character", new Set(["description"]), []);
	assert.ok(!/### Background/.test((vault as MockVault).contentAt(file.path) ?? ""), "the selection did not apply");
	const parsed = await readElement(app, file);
	assert.equal(parsed?.fields.description, "Line one.\n");
});

test("row 16: Add Custom Field keeps the trailing whitespace of the note's last value", async () => {
	const { app } = makeApp();
	const file = (await writeElement(app, "W", "character", ID, { name: "Ireena", reputation: "Feared.\n\n" })) as TFile;
	(app as unknown as { workspace: { getActiveFile(): TFile } }).workspace.getActiveFile = () => file;
	__modals.length = 0;
	await new ManageFieldsCommand(app).addCustomField();
	const prompt = __modals.at(-1) as unknown as { onSubmit(v: string): Promise<void> };
	await prompt.onSubmit("Looks");
	const parsed = await readElement(app, file);
	assert.equal(parsed?.fields.reputation, "Feared.\n\n");
	assert.equal(parsed?.fields.x_looks, "");
});

test("row 16: folder import then export keeps a description's whitespace and CRLF", async () => {
	const { app, vault } = makeApp();
	const description = "  A noble.  \r\nSecond line.\n";
	await vault.seed("in/b/world.json", JSON.stringify({ id: WID, name: "Barovia" }));
	await vault.seed(
		"in/b/elements/character/ireena--000000e1.json",
		JSON.stringify({ id: ID, type: "character", name: "Ireena", description, background: "\tTabbed." })
	);
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
	const before = new Set(vault.files.keys());
	await (new ExportFolderCommand(app) as unknown as {
		exportWorld(w: string, d: { kind: "vault" }): Promise<void>;
	}).exportWorld("Barovia", { kind: "vault" });
	const rel = [...vault.files.keys()].find((p) => !before.has(p) && p.includes("/elements/character/"))!;
	const body = JSON.parse(vault.contentAt(rel)!);
	assert.equal(body.description, description);
	assert.equal(body.background, "\tTabbed.");
});
