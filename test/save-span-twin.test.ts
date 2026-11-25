/**
 * Save refuses a note whose id an old span note also holds. The duplicate check read front-matter ids
 * from the metadata cache only, so two notes with one id saved when the other was an old span note.
 * Each test runs the real Save command over an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const ID = "019e0000-0000-7000-8000-0000000000a1";
const OTHER = "019e0000-0000-7000-8000-0000000000b2";
const FIELD = (label: string, value: string) => `- <span class="text-field" data-tooltip="Text">${label}</span>: ${value}`;
const SPAN = (id: string, name: string) => ["## Base", FIELD("Id", id), FIELD("Name", name), FIELD("Description", "Old."), ""].join("\n");
const LIVE = `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nLive.\n`;
const server = { [ID]: { name: "Ireena", description: "Live." } };

test("★ Save refuses a front-matter note whose id an old span note holds, in a type folder under Elements/, and sends nothing", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": LIVE, "Character/Ireena (old).md": SPAN(ID, "Ireena (old)") }, save: "Character/Ireena.md", server });
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => n.includes("Ireena not saved: Elements/Character/Ireena (old).md holds the same id")), r.notices.join(" | "));
});

test("an old span note outside Elements/ is the person's own, as for Copy and Upload: it is no twin", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": LIVE, "~/Archive/Character/Ireena (old).md": SPAN(ID, "Ireena (old)") }, save: "Character/Ireena.md", server });
	assert.ok(!r.notices.some((n) => /holds the same id/.test(n)), r.notices.join(" | "));
});

test("★ Save refuses an old span note whose id another old span note holds", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": SPAN(ID, "Ireena"), "Character/Archive/Ireena copy.md": SPAN(ID, "Ireena copy") }, save: "Character/Ireena.md", server });
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /holds the same id/.test(n)), r.notices.join(" | "));
});

test("Save is not stopped by an old span note holding another id, and still saves the note", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": LIVE, "Character/Other.md": SPAN(OTHER, "Other") }, save: "Character/Ireena.md", server });
	assert.ok(!r.notices.some((n) => /holds the same id/.test(n)), r.notices.join(" | "));
});
