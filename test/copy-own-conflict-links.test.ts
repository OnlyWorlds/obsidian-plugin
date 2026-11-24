/**
 * Copy world reads each note once and refuses what Upload refuses (#2255): a note whose own property is
 * written two ways (mood beside x_properties.mood) is not copied, and an old span note's links resolve from
 * the listing Copy already read, never from a second read that can throw and leave the link empty.
 * Each test runs the real Copy command over an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __notices, MockVault } from "./support/obsidian-mock";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";
import { W, E } from "./support/four-notes";

const A = "019e0000-0000-7000-8000-0000000000a1";
const B = "019e0000-0000-7000-8000-0000000000b2";
const FIELD = (label: string, value: string, cls = "text-field", tip = "Text") => `- <span class="${cls}" data-tooltip="${tip}">${label}</span>: ${value}`;
const CONFLICT = `---\nid: ${A}\nname: Ann\nmood: tense\nx_properties:\n  mood: calm\n---\n\n### Description\n\nAnn prose.\n`;
const FINE = `---\nid: ${B}\nname: Bob\nmood: tense\n---\n\n### Description\n\nBob prose.\n`;

async function copy(notes: Record<string, string>, tweak?: (vault: MockVault) => void) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(`${E}/${p}`, t);
	tweak?.(vault);
	__notices.length = 0;
	const data = (await new CopyWorldCommand(app as App, {} as never, new WorldService(app as App)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;
	return { data, notices: [...__notices] };
}

test("★ Copy world refuses a note whose own property is written two ways, as Upload does; a note with one way is copied", async () => {
	const r = await copy({ "Character/Ann.md": CONFLICT, "Character/Bob.md": FINE });
	const chars = r.data.Character ?? [];
	assert.ok(!chars.some((e) => e.id === A), "Copy kept one of two values silently: " + JSON.stringify(chars));
	assert.ok(chars.some((e) => e.id === B), JSON.stringify(chars));
	assert.ok(r.notices.some((n) => /"Ann" not copied: mood is both a property of the note and inside its x_properties/.test(n)), r.notices.join(" | "));
});

const ANN_SPAN = ["## Base", FIELD("Id", A), FIELD("Name", "Ann"), FIELD("Friends", "[[Ann]]", "multi-link-field", "Multi Character"), ""].join("\n");
const BOB_SPAN = ["## Base", FIELD("Id", B), FIELD("Name", "Bob"), FIELD("Rival", "[[Ann]]", "single-link-field", "Single Character"), ""].join("\n");

test("★ Copy world resolves an old span note's links from its one reading of the notes: no note is read twice, and a second read that throws changes nothing", async () => {
	const reads: Record<string, number> = {};
	const r = await copy({ "Character/Ann.md": ANN_SPAN, "Character/Bob.md": BOB_SPAN }, (vault) => {
		const proto = Object.getPrototypeOf(vault) as { read(f: { path: string }): Promise<string> };
		const orig = proto.read;
		proto.read = function (this: unknown, f: { path: string }) {
			reads[f.path] = (reads[f.path] ?? 0) + 1;
			return reads[f.path] > 1 ? Promise.reject(new Error("EBUSY: read twice")) : orig.call(this, f);
		};
	});
	const chars = r.data.Character ?? [];
	const ann = chars.find((e) => e.id === A);
	const bob = chars.find((e) => e.id === B);
	assert.deepEqual(ann?.friends, [A], JSON.stringify(chars));
	assert.equal(bob?.rival, A, JSON.stringify(chars));
	assert.deepEqual(Object.entries(reads).filter(([, n]) => n > 1), [], "notes read more than once: " + JSON.stringify(reads));
});
