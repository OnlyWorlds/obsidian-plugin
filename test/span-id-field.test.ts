/**
 * An old span note's field can never change the id the note is counted and sent under.
 * A text field labelled `Id_id` was read as the link suffix `_id` of a field called `id`, so the wire
 * conversion, which runs after the duplicate count, replaced the note's own id with the field's value.
 * Each test runs the real Upload command over an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessUpload } from "./support/upload-harness";
import { toV2WireKeys } from "../vault/element-transform";

const OLD_ID = "019e0000-0000-7000-8000-0000000000a1";
const BOB_ID = "019e0000-0000-7000-8000-0000000000b2";
const FIELD = (label: string, value: string) => `- <span class="text-field" data-tooltip="Text">${label}</span>: ${value}`;
const BOB = `---\nid: ${BOB_ID}\nname: Bob\n---\n\n### Description\n\nBob prose.\n`;
const OLD = (extra: string[]) => ["## Base", FIELD("Id", OLD_ID), FIELD("Name", "Old"), ...extra, FIELD("Description", "Old prose."), ""].join("\n");
const sent = (up: Awaited<ReturnType<typeof harnessUpload>>): Record<string, unknown>[] => [...up.bulkSent, ...Object.entries(up.patches).map(([id, b]) => ({ id, ...b }))];

test("★ Upload sends an old span note under the id it was counted by, whatever a field in it is labelled", async () => {
	for (const label of ["Id_id", "id_id", "Id_ids", "World", "World_id"]) {
		const up = await harnessUpload({ notes: { "Character/Bob.md": BOB, "Character/Old.md": OLD([FIELD(label, BOB_ID)]) }, changes: [] });
		const owners = sent(up).filter((e) => e.id === BOB_ID);
		assert.equal(owners.length, 1, `${label}: Bob's id was sent ${owners.length} times: ` + JSON.stringify(sent(up)));
		assert.equal(owners[0].name, "Bob", `${label}: ` + JSON.stringify(owners));
		assert.ok(sent(up).some((e) => e.id === OLD_ID && e.name === "Old"), `${label}: the old note was not sent under its own id: ` + JSON.stringify(sent(up)));
	}
});

test("the wire conversion never lets a stripped suffix produce the element's own id or its world", () => {
	assert.deepEqual(toV2WireKeys({ id: OLD_ID, id_id: BOB_ID, id_ids: [BOB_ID], world_ids: ["w"], name: "Old" }), { id: OLD_ID, name: "Old" });
	assert.deepEqual(toV2WireKeys({ id_id: BOB_ID, name: "No own id" }), { name: "No own id" }, "order does not matter");
	assert.deepEqual(toV2WireKeys({ element_id: "abc", location_id: "l1" }), { element_id: "abc", location: "l1" });
});
