/**
 * Round C, item 6 (Kael's delta read, low 2): the canvas hash fell back to a
 * file node's own `el-<id>` whenever its path named no element, so a card
 * re-pointed to a note with no id, to an attachment, or to a path no file
 * holds read as unchanged, and the redraw overwrote the user's change with
 * no `(your copy)`. Now the card's own element stands in only for a folder
 * rename nothing rewrote: no file at the path, and the element's note under
 * the same file name elsewhere (or a note Obsidian has not indexed yet).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DrawRelationshipsCommand } from "../Commands/DrawRelationshipsCommand";
import type { CanvasData } from "../vault/relationship-canvas";

const W = "OnlyWorlds/Worlds/Hyperion/Elements";
const KASSAD = `${W}/Character/Kassad.md`;
const BLADE = `${W}/Object/Blade.md`;
const CANVAS = `${W}/Character/Kassad — relationships.canvas`;
const COPY = `${W}/Character/Kassad — relationships (your copy).canvas`;

type MockApp = ReturnType<typeof makeApp>;

async function drawn(): Promise<MockApp> {
	const m = makeApp();
	const { app, vault } = m;
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	await vault.seed(KASSAD, `---\nid: 0199c000-0000-7000-8000-0000000000c1\nname: Kassad\nobjects:\n  - "[[Blade]]"\n---\n`);
	await vault.seed(BLADE, `---\nid: 0199c000-0000-7000-8000-0000000000b1\nname: Blade\n---\n`);
	await vault.seed(`${W}/Object/Plain note.md`, "Just a note, no id.\n");
	await vault.seed("Attachments/map.png", "png");
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () => vault.files.get(KASSAD)?.file ?? null;
	await new DrawRelationshipsCommand(app, () => true).execute();
	return m;
}

async function repointAndRedraw(m: MockApp, to: string): Promise<void> {
	const { app, vault } = m;
	const c = JSON.parse(vault.contentAt(CANVAS)!) as CanvasData;
	(c.nodes.find((n) => n.type === "file" && n.file === BLADE) as { file: string }).file = to;
	await vault.modify(vault.files.get(CANVAS)!.file, JSON.stringify(c, null, "\t"));
	await new DrawRelationshipsCommand(app, () => true).execute();
}

for (const [what, to] of [
	["a note with no id", `${W}/Object/Plain note.md`],
	["an attachment", "Attachments/map.png"],
	["a path no file holds", `${W}/Object/Nowhere.md`],
] as const) {
	test(`★ a card re-pointed to ${what} is the user's change: the redraw saves (your copy) first`, async () => {
		const m = await drawn();
		await repointAndRedraw(m, to);
		assert.ok(m.vault.contentAt(COPY), "the user's version was overwritten with no copy");
	});
}

test("a folder rename nothing rewrote is still no change: the note is under the same file name elsewhere", async () => {
	const m = await drawn();
	m.vault.move(`${W}/Object`, `${W}/Object (2)`);
	await new DrawRelationshipsCommand(m.app, () => true).execute();
	assert.equal(m.vault.contentAt(COPY), undefined);
});
