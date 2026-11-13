/**
 * The incoming links of a relationship graph come in a fixed order (the path),
 * not the vault's file order: the canvas places its left half in this order.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { gatherRelationshipGraph } from "../vault/relationship-graph";

const W = "OnlyWorlds/Worlds/Hyperion/Elements";

test("incoming links are sorted by path whatever order the vault holds the files in", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	await vault.seed(`${W}/Location/Keats.md`, `---\nid: 0199c000-0000-7000-8000-0000000000a1\nname: Keats\n---\n`);
	// Seeded in reverse: Zed first, Alpha last.
	await vault.seed(`${W}/Character/Zed.md`, `---\nid: 0199c000-0000-7000-8000-0000000000c9\nname: Zed\nlocation: "[[Keats]]"\n---\n`);
	await vault.seed(`${W}/Character/Mid.md`, `---\nid: 0199c000-0000-7000-8000-0000000000c5\nname: Mid\nlocation: "[[Keats]]"\n---\n`);
	await vault.seed(`${W}/Character/Alpha.md`, `---\nid: 0199c000-0000-7000-8000-0000000000c1\nname: Alpha\nlocation: "[[Keats]]"\n---\n`);
	const file = vault.files.get(`${W}/Location/Keats.md`)!.file;
	const g = await gatherRelationshipGraph(app as never, file as never, { incoming: true });
	assert.ok(g);
	const paths = g.incoming.map((i) => (i.from.kind === "file" ? i.from.path : ""));
	assert.deepEqual(paths, [`${W}/Character/Alpha.md`, `${W}/Character/Mid.md`, `${W}/Character/Zed.md`]);
});
