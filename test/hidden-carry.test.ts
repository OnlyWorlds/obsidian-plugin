/**
 * OW Infra #426, the coordinator's addendum: the folder export, Copy World and
 * Paste World never carry a stub (a hidden element's note) as an element with
 * empty fields, nor an element whose id is on a hidden list; Paste never
 * writes a hidden id's old copy over its stub.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { WorldService } from "../Scripts/WorldService";
import { HIDDEN_STUB_LINE } from "../sync/hidden-on-server";

const WID = "0199c000-0000-7000-8000-0000000000ee";
const ZEL = "0199c000-0000-7000-8000-0000000000c1";
const IRE = "0199c000-0000-7000-8000-0000000000c2";
const KAS = "0199c000-0000-7000-8000-0000000000c3";

const STUB = `---\nname:\nid: ${ZEL}\n---\n\nMine.\n\n${HIDDEN_STUB_LINE}\n`;
const note = (id: string, name: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nAbout ${name}.\n`;
const host = { settings: { hiddenOnServer: { [WID]: [KAS] } } };

async function seeded() {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n- **Name:** W\n");
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Zelraun.md", STUB);
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Ireena.md", note(IRE, "Ireena"));
	// Hidden, its note not yet a stub (no Download since the hide).
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Kasimir.md", note(KAS, "Kasimir"));
	return { app, vault };
}

type Plan = { files: { rel: string; content: string }[]; hidden?: number };

test("★ a folder export over a vault holding a stub writes no element for it, nor for a hidden id; it counts them", async () => {
	const { app } = await seeded();
	const plan = await (new ExportFolderCommand(app as never, host) as unknown as { planFiles(w: string, id: string): Promise<Plan> }).planFiles("W", WID);
	const all = plan.files.map((f) => f.content).join("\n");
	assert.ok(all.includes(IRE), "the visible element was not exported");
	assert.ok(!all.includes(ZEL), "the stub was exported as an element");
	assert.ok(!all.includes(KAS), "a hidden id was exported");
	assert.equal(plan.hidden, 2);
});

test("★ Copy World leaves out a stub and a hidden id", async () => {
	const { app } = await seeded();
	const data = (await new CopyWorldCommand(app as App, {} as never, new WorldService(app as App), host).collectWorldData("OnlyWorlds/Worlds/W")) as Record<string, Record<string, unknown>[]>;
	const ids = (data.Character ?? []).map((e) => String(e.id));
	assert.deepEqual(ids, [IRE]);
});

test("★ Paste World never writes a hidden id's copy over its stub, nor a hidden id's note", async () => {
	const { app, vault } = await seeded();
	const files = vault as unknown as { files: Map<string, { content: string }> };
	const zelPath = "OnlyWorlds/Worlds/W/Elements/Character/Zelraun.md";
	const kasPath = "OnlyWorlds/Worlds/W/Elements/Character/Kasimir.md";
	const kasBefore = files.files.get(kasPath)?.content;
	const cmd = new PasteWorldCommand(app as App, {} as never, host);
	await cmd.generateElementNotes("OnlyWorlds/Worlds/W/Elements", {
		Character: [
			{ id: ZEL, name: "Zelraun", description: "The hidden text, from an old copy." },
			{ id: KAS, name: "Kasimir", description: "Old copy of a hidden one." },
			{ id: IRE, name: "Ireena", description: "Pasted." },
		],
	}, false);
	assert.equal(files.files.get(zelPath)?.content, STUB);
	assert.equal(files.files.get(kasPath)?.content, kasBefore);
	assert.ok(files.files.get("OnlyWorlds/Worlds/W/Elements/Character/Ireena.md")?.content.includes("Pasted."));
	void ({} as TFile);
});
