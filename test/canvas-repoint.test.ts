/**
 * Round C, item 6 (Kael's delta read, low 2): the canvas hash fell back to a
 * file node's own `el-<id>` whenever its path named no element, so a card
 * re-pointed to a note with no id, or to a file outside the world, read as
 * unchanged, and the redraw overwrote the user's change with no `(your copy)`.
 *
 * Kept from 3.5.0 (Kael's guard): a card whose path no longer resolves is
 * unchanged while its element still has a note in the world, a rename the
 * canvas did not see. It is the user's change when it points at another
 * element's note, at a note with no id, or at a file outside the world.
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
const BLADE_ID = "0199c000-0000-7000-8000-0000000000b1";
const CANVAS = `${W}/Character/Kassad — relationships.canvas`;
const COPY = `${W}/Character/Kassad — relationships (your copy).canvas`;

type MockApp = ReturnType<typeof makeApp>;

async function drawn(): Promise<MockApp> {
	const m = makeApp();
	const { app, vault } = m;
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	await vault.seed(KASSAD, `---\nid: 0199c000-0000-7000-8000-0000000000c1\nname: Kassad\nobjects:\n  - "[[Blade]]"\n  - "[[Farcaster]]"\n---\n`);
	await vault.seed(BLADE, `---\nid: ${BLADE_ID}\nname: Blade\n---\n`);
	await vault.seed(`${W}/Object/Farcaster.md`, `---\nid: 0199c000-0000-7000-8000-0000000000b2\nname: Farcaster\n---\n`);
	await vault.seed(`${W}/Object/Plain note.md`, "Just a note, no id.\n");
	// Another world's copy of Blade's note, its id the same.
	await vault.seed("OnlyWorlds/Worlds/Copy/Elements/Object/Blade.md", `---\nid: ${BLADE_ID}\nname: Blade\n---\n`);
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
	["another element's note", `${W}/Object/Farcaster.md`],
	["a note with no id", `${W}/Object/Plain note.md`],
	["a note outside the world (one holding the same id)", "OnlyWorlds/Worlds/Copy/Elements/Object/Blade.md"],
] as const) {
	test(`★ a card re-pointed to ${what} is the user's change: the redraw saves (your copy) first`, async () => {
		const m = await drawn();
		await repointAndRedraw(m, to);
		assert.ok(m.vault.contentAt(COPY), "the user's version was overwritten with no copy");
	});
}

test("★ a note renamed alone, the canvas not rewritten, is no change: no (your copy)", async () => {
	const m = await drawn();
	m.vault.move(BLADE, `${W}/Object/Blade of Thorns.md`);
	await new DrawRelationshipsCommand(m.app, () => true).execute();
	assert.equal(m.vault.contentAt(COPY), undefined);
});

test("a folder rename nothing rewrote is no change either", async () => {
	const m = await drawn();
	m.vault.move(`${W}/Object`, `${W}/Object (2)`);
	await new DrawRelationshipsCommand(m.app, () => true).execute();
	assert.equal(m.vault.contentAt(COPY), undefined);
});
