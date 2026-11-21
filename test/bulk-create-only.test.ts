/**
 * Every /bulk the plugin sends is a
 * create by intent, so it carries `create_only: true`. A held id then answers
 * 409 `id_conflict` in its own slot and keel does NOT replace the element; the
 * plugin names the item and says so in its own words (keel's text names the id
 * and the PUT road, which a person cannot take). Without the word a replace
 * race silently overwrote the held element (and the save's notice said
 * "replaced").
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { setRequestUrl, __requests } from "./support/obsidian-mock";
import { V2Client, bulkSlotWhy } from "../client-v2";
import { harnessSave } from "./support/save-harness";
import { harnessUpload } from "./support/upload-harness";

const IREENA = "0199c000-0000-7000-8000-0000000000e1";
const KOLYAN = "0199c000-0000-7000-8000-0000000000e2";
const ITEMS = [{ type: "character", element: { id: KOLYAN, name: "Kolyan" } }];

async function wireBody(opts?: { atomic?: boolean; createOnly?: boolean }): Promise<Record<string, unknown>> {
	__requests.length = 0;
	setRequestUrl(() => ({ status: 200, json: { errors: false, items: [{ status: 201, id: KOLYAN }] } }));
	await new V2Client("ow_k_test", "1234").bulkCreate(ITEMS, opts);
	const post = __requests.find((r) => r.method === "POST" && /\/bulk$/.test(new URL(r.url).pathname.replace(/\/$/, "")));
	assert.ok(post?.body, "no POST /bulk was sent");
	return JSON.parse(post.body) as Record<string, unknown>;
}

test("★ createOnly puts create_only: true on the batch body, beside atomic when both are asked", async () => {
	assert.deepEqual(await wireBody({ createOnly: true }), { items: ITEMS, create_only: true });
	assert.deepEqual(await wireBody({ atomic: true, createOnly: true }), { items: ITEMS, atomic: true, create_only: true });
});

test("a batch that does not ask for it carries no create_only (keel refuses a key it does not know only when we send one)", async () => {
	assert.deepEqual(await wireBody(), { items: ITEMS });
	assert.deepEqual(await wireBody({ atomic: true }), { items: ITEMS, atomic: true });
});

test("★ the create-first batch of a save asks for create-only, and a held target is refused by name in the plugin's words", async () => {
	const notes = {
		"Character/Ireena.md": `---\nname: Ireena\nid: ${IREENA}\nfriends:\n  - "[[Kolyan]]"\n---\n\n### Description\n\nA noble.\n`,
		"Character/Kolyan.md": `---\nname: Kolyan\nid: ${KOLYAN}\n---\n\n### Description\n\nA burgomaster.\n`,
	};
	const r = await harnessSave({
		notes,
		save: "Character/Ireena.md",
		server: { [IREENA]: { name: "Ireena", description: "A noble." } },
		bulkStatus: (id) => (id === KOLYAN ? 409 : 201),
	});
	assert.deepEqual(r.bulkOpts, [{ atomic: true, createOnly: true }]);
	const said = JSON.stringify(r.result) + " | " + r.notices.join(" | ");
	assert.match(said, /Character "Kolyan": an element with its id was made on onlyworlds\.com meanwhile/, said);
	assert.match(said, /nothing there was replaced/, said);
	assert.doesNotMatch(said, /Use PUT|POST without an id/, "keel's own sentence reached the person");
	assert.doesNotMatch(said, /was already on onlyworlds\.com .* replaced/, "the replaced notice must not come from a refusal");
});

test("★ Upload World's creates ask for create-only, and a held id is a failure naming the item, not a replace", async () => {
	const note = (id: string, name: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nA city.\n`;
	const r = await harnessUpload({
		notes: { "Location/Gela.md": note(KOLYAN, "Gela"), "Location/Akragas.md": note(IREENA, "Akragas") },
		changes: [],
		conflict: [KOLYAN],
	});
	assert.deepEqual(r.bulkOpts, [{ createOnly: true }]);
	const said = r.notices.join(" | ");
	assert.match(said, /Gela": an element with its id was made on onlyworlds\.com meanwhile/, said);
	assert.doesNotMatch(said, /Use PUT|POST without an id/, said);
});

test("★ bulkSlotWhy says each of keel's four 409s in its own words, with the remedy a person can take, and never 'hidden'", () => {
	const why = (message: string) => bulkSlotWhy({ status: 409, error: { code: "id_conflict", message } });
	// The messages are keel's own builders (elements/service.py), copied.
	const same = why("An element with id x already exists. Use PUT to upsert, or POST without an id.");
	assert.match(same, /^an element with its id was made on onlyworlds\.com meanwhile/);
	assert.match(why("An element with id x already exists as a location in this world. Element ids are unique across every type: PUT it as a location, or POST without an id."), /^its id already belongs to a location on onlyworlds\.com/);
	const other = why("An element with id x already exists in another world. Element ids are unique across all worlds: give this element a new id (a copied world folder needs fresh ids).");
	assert.match(other, /another world/);
	assert.match(other, /give this note a new id/);
	assert.match(why("The id x is already in use. Give this element a new id."), /already in use on onlyworlds\.com: give this note a new id/);
	assert.match(why("something keel says later"), /^its id is already held on onlyworlds\.com/);
	for (const s of [same, other]) assert.doesNotMatch(s, /hidden|Use PUT|POST without/);
	assert.equal(bulkSlotWhy({ status: 422, error: { code: "invalid_request", message: "name is required" } }), "name is required");
	assert.equal(bulkSlotWhy({ status: 500 }), "status 500");
	assert.equal(bulkSlotWhy(null), "no result from the server");
});
