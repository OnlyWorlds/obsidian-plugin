/**
 * Round C fix round, item 2 (Kael's c-read, should-fix 2, a regression from
 * 336e123): the folder export resolves a prose `[[link]]` by the note
 * Obsidian resolves it to, and in a vault with two worlds that each hold a
 * `Vallaki` (Copy World then Paste World makes it) Obsidian may pick the
 * other world's note. The mention then went out as literal `[[Vallaki]]`,
 * its id lost. Now a link that lands outside this world falls back to this
 * world's own notes by name, as the save path does.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";

const WID = "0199c000-0000-7000-8000-0000000000ee";
const V_AAA = "0199c000-0000-7000-8000-0000000000a1";
const V_BBB = "0199c000-0000-7000-8000-0000000000b1";
const IREENA = "0199c000-0000-7000-8000-0000000000b2";
const T1 = "0199c000-0000-7000-8000-0000000000b3";
const T2 = "0199c000-0000-7000-8000-0000000000b4";

type Plan = { files: { rel: string; content: string }[] };
const plan = (app: unknown, world: string) =>
	(new ExportFolderCommand(app as never) as unknown as { planFiles(w: string, id: string): Promise<Plan> }).planFiles(world, WID);

const descriptionOf = (p: Plan, slug: string): string => {
	const f = p.files.find((x) => x.rel.includes(slug));
	assert.ok(f, `${slug} not exported: ${p.files.map((x) => x.rel).join(", ")}`);
	return String(JSON.parse(f.content).description);
};

test("★ in a vault with two worlds, [[Vallaki]] exports as the mention of this world's Vallaki", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Aaa/Elements/Location/Vallaki.md", `---\nname: Vallaki\nid: ${V_AAA}\n---\n\n### Description\n\nA town.\n`);
	await vault.seed("OnlyWorlds/Worlds/Bbb/Elements/Location/Vallaki.md", `---\nname: Vallaki\nid: ${V_BBB}\n---\n\n### Description\n\nA town.\n`);
	await vault.seed(
		"OnlyWorlds/Worlds/Bbb/Elements/Character/Ireena.md",
		`---\nname: Ireena\nid: ${IREENA}\n---\n\n### Description\n\nBorn in [[Vallaki]].\n`
	);
	const p = await plan(app, "Bbb");
	assert.equal(descriptionOf(p, "ireena"), `Born in [Vallaki](ow://location/${V_BBB}).`);
});

test("two notes of this world by that name are never guessed: the link stays as written", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Aaa/Elements/Character/Twin.md", `---\nname: Twin\nid: ${V_AAA}\n---\n`);
	await vault.seed("OnlyWorlds/Worlds/Bbb/Elements/Character/Twin.md", `---\nname: Twin\nid: ${T1}\n---\n`);
	await vault.seed("OnlyWorlds/Worlds/Bbb/Elements/Location/Twin.md", `---\nname: Twin\nid: ${T2}\n---\n`);
	await vault.seed(
		"OnlyWorlds/Worlds/Bbb/Elements/Character/Ireena.md",
		`---\nname: Ireena\nid: ${IREENA}\n---\n\n### Description\n\nSee [[Twin]].\n`
	);
	const p = await plan(app, "Bbb");
	const d = descriptionOf(p, "ireena");
	assert.ok(!d.includes(V_AAA), `resolved into the other world: ${d}`);
});
