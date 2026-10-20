/**
 * OW Infra #426: an element hidden by the world's owner (keel's hidden mark,
 * Keel #421; the one rule's sheet §1 and §3, D124, D127). A feed delete row
 * with `reason: "hidden"` stubs the note: the element's fields go, the
 * person's own writing stays byte for byte, a line says why. A 409
 * resync_required with `reason: "view"` stubs the notes the fresh walk no
 * longer names; `role`, or no reason, keeps every note. The pure core.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { setRequestUrl } from "./support/obsidian-mock";
import {
	HIDDEN_STUB_LINE,
	hiddenNotices,
	isHiddenId,
	isStubNote,
	planHidden,
	resyncReasonOf,
	stubKeptText,
	stubNote,
} from "../sync/hidden-on-server";
import { keptDeleteCount } from "../sync/deleted-on-server";
import { V2ApiError, V2Client } from "../client-v2";

const A = "019e0000-0000-7000-8000-0000000000a1";
const B = "019e0000-0000-7000-8000-0000000000b2";
const C = "019e0000-0000-7000-8000-0000000000c3";
const D = "019e0000-0000-7000-8000-0000000000d4";

/** A Character note as Download writes it, with the person's own writing around the fields. */
const MINE_BEFORE = "My own table notes, before any field.\n\n";
const MINE_SECTION = "### My table's rumours, unsorted\n\nHe owes the Vistani money.\n\n";
const NOTE = [
	"---",
	"name: Zelraun",
	`id: ${A}`,
	"supertype: noble",
	"tags:",
	"  - my-campaign",
	"height: 182",
	"species:",
	'  - "[[Human]]"',
	'location: "[[Waterdeep]]"',
	"atlas_color: red",
	"x_mood: grim",
	"---",
	"",
	MINE_BEFORE + "### Description\n\nA knight of Barovia.\n\n" + MINE_SECTION + "### Background\n\nBorn in Krezk.\n\n### Looks\n\nScarred.\n",
].join("\n");

const STUB = [
	"---",
	"name:",
	`id: ${A}`,
	"supertype:",
	"tags:",
	"  - my-campaign",
	"height:",
	"species: []",
	"location:",
	"atlas_color:",
	"x_mood:",
	"---",
	"",
	MINE_BEFORE + HIDDEN_STUB_LINE + "\n\n" + MINE_SECTION,
].join("\n");

test("★ a hidden row's stub: every element field gone, the person's writing kept byte for byte, the stub line where the fields were", () => {
	const out = stubNote(NOTE, "Character");
	assert.equal(out, STUB);
	assert.ok(out.includes(MINE_BEFORE) && out.includes(MINE_SECTION), "the person's writing was not kept byte for byte");
	for (const gone of ["Zelraun", "noble", "182", "Human", "Waterdeep", "red", "grim", "A knight", "Krezk", "Scarred"]) {
		assert.ok(!out.includes(gone), `the hidden element's ${gone} was kept`);
	}
	assert.ok(out.startsWith("---\n"), "the frontmatter left byte 0");
});

test("★ a second hidden row on a stub changes nothing", () => {
	assert.equal(stubNote(STUB, "Character"), STUB);
	const bare = `---\nname: Zelraun\nid: ${A}\n---\n\n### Description\n\nA knight.\n`;
	const once = stubNote(bare, "Character");
	assert.equal(once, `---\nname:\nid: ${A}\n---\n\n${HIDDEN_STUB_LINE}\n`);
	assert.equal(stubNote(once, "Character"), once);
	// Writing kept before the stub line, with no heading left: still a stub, kept whole.
	const kept = stubNote(`---\nname: Z\nid: ${A}\n---\n\nMine.\n\n### Description\n\nTheirs.\n`, "Character");
	assert.equal(kept, `---\nname:\nid: ${A}\n---\n\nMine.\n\n${HIDDEN_STUB_LINE}\n`);
	assert.equal(stubNote(kept, "Character"), kept);
});

test("a CRLF note keeps the person's CRLF bytes", () => {
	const crlf = NOTE.replace(/\n/g, "\r\n");
	const out = stubNote(crlf, "Character");
	assert.ok(out.includes(MINE_BEFORE.replace(/\n/g, "\r\n")));
	assert.ok(out.includes(MINE_SECTION.replace(/\n/g, "\r\n")));
	assert.ok(out.includes(`${HIDDEN_STUB_LINE}\r\n`));
	assert.ok(!out.includes("Zelraun") && !out.includes("A knight"));
	assert.equal(stubNote(out, "Character"), out);
});

test("a heading in a code fence of the person's section is the person's text, not a field", () => {
	const fenced = `---\nname: Z\nid: ${A}\n---\n\n### Description\n\nTheirs.\n\n### Notes, mine\n\n\`\`\`\n### Background\n\`\`\`\n`;
	const out = stubNote(fenced, "Character");
	assert.ok(out.endsWith("### Notes, mine\n\n```\n### Background\n```\n"));
	assert.ok(!out.includes("Theirs."));
});

test("a body with no field heading (a 3.0 note) is the description: it goes", () => {
	const out = stubNote(`---\nname: Z\nid: ${A}\n---\n\nThe whole description.\n`, "Character");
	assert.equal(out, `---\nname:\nid: ${A}\n---\n\n${HIDDEN_STUB_LINE}\n`);
});

test("★ a note with no element id is never stubbed (a person's own note)", () => {
	const own = "---\ntags:\n  - mine\n---\n\n### Description\n\nMy own note.\n";
	assert.equal(stubNote(own, "Character"), own);
	assert.equal(stubNote("Just prose.\n", "Character"), "Just prose.\n");
});

test("isStubNote: a stub is one; the note it came from is not", () => {
	assert.equal(isStubNote(STUB), true);
	assert.equal(isStubNote(NOTE), false);
	assert.equal(isStubNote(`Prose.\n\n${HIDDEN_STUB_LINE}\n`), false, "no element id");
});

const hide = (id: string) => ({ id, op: "delete", reason: "hidden" });
const del = (id: string, reason?: string) => (reason ? { id, op: "delete", reason } : { id, op: "delete" });
const up = (id: string) => ({ id, op: "upsert" });

test("★ a hidden row stubs a note here and joins the hidden list; one with no note here only joins the list", () => {
	const plan = planHidden({ latest: [hide(A), hide(B)], fromStart: false, resync: null, ownIds: new Set([A]) });
	assert.deepEqual(plan.stubHidden, [A]);
	assert.deepEqual([...plan.hidden].sort(), [A, B]);
	assert.deepEqual(plan.stubView, []);
});

test("★ a plain delete row keeps today's path: no stub, not on the hidden list, counted as a kept delete", () => {
	for (const row of [del(A), del(A, "deleted")]) {
		const plan = planHidden({ latest: [row], fromStart: false, resync: null, ownIds: new Set([A]) });
		assert.deepEqual(plan.stubHidden, []);
		assert.equal(plan.hidden.size, 0);
		assert.equal(keptDeleteCount([row], new Set([A])), 1);
	}
	assert.equal(keptDeleteCount([hide(A)], new Set([A])), 0, "a hidden row was counted as a delete");
});

test("★ an unhide (an upsert later in the feed) takes the id off the hidden list", () => {
	const plan = planHidden({ latest: [up(A)], storedHidden: [A, B], fromStart: false, resync: null, ownIds: new Set([A, B]) });
	assert.deepEqual([...plan.hidden], [B]);
	assert.deepEqual(plan.stubHidden, []);
});

test("★ a role resync, or one with no reason, keeps every note", () => {
	for (const resync of ["role", "none"] as const) {
		const plan = planHidden({ latest: [up(B)], storedKnown: [A, B], fromStart: true, resync, ownIds: new Set([A, B]) });
		assert.deepEqual(plan.stubView, [], `${resync} stubbed a note`);
		assert.equal(plan.hidden.size, 0);
		assert.deepEqual([...plan.known], [B], "what the walk no longer names stays the person's for good");
	}
});

test("★ a view resync stubs exactly the element notes the fresh walk does not name", () => {
	// A and C were on the server before; B is named again; D was never on the
	// server (a note made here, not yet saved); C has no note here.
	const plan = planHidden({ latest: [up(B)], storedKnown: [A, B, C], fromStart: true, resync: "view", ownIds: new Set([A, B, D]) });
	assert.deepEqual(plan.stubView, [A]);
	assert.ok(plan.hidden.has(A));
	assert.ok(!plan.hidden.has(D), "a note never on the server was taken for hidden");
	assert.deepEqual([...plan.known], [B]);
});

test("a view resync does not stub again what is already hidden", () => {
	const plan = planHidden({ latest: [], storedHidden: [A], storedKnown: [A], fromStart: true, resync: "view", ownIds: new Set([A]) });
	assert.deepEqual(plan.stubView, []);
	assert.ok(plan.hidden.has(A));
});

test("an incremental walk adds what it upserts to what this device knows on the server, and drops what it deletes", () => {
	const plan = planHidden({ latest: [up(C), del(A)], storedKnown: [A, B], fromStart: false, resync: null, ownIds: new Set() });
	assert.deepEqual([...plan.known].sort(), [B, C]);
});

test("★ a stub's kept writing is everything but the stub line, byte for byte (what an unhide carries)", () => {
	assert.equal(stubKeptText(STUB), MINE_BEFORE + MINE_SECTION);
	assert.equal(stubKeptText(`---\nname:\nid: ${A}\n---\n\n${HIDDEN_STUB_LINE}\n`), "");
	assert.equal(stubKeptText(NOTE), "", "a note that is no stub has nothing to carry");
});

test("★ a role or no-reason reset puts what the walk no longer names (and was known) on leftView; an upsert takes it off", () => {
	for (const resync of ["role", "none"] as const) {
		const plan = planHidden({ latest: [up(B)], storedKnown: [A, B, C], storedLeftView: [D], fromStart: true, resync, ownIds: new Set([A, B]) });
		assert.deepEqual([...plan.leftView].sort(), [A, C, D].sort());
		assert.deepEqual(plan.stubView, []);
	}
	const later = planHidden({ latest: [up(A)], storedLeftView: [A, C], fromStart: false, resync: null, ownIds: new Set() });
	assert.deepEqual([...later.leftView], [C]);
	const view = planHidden({ latest: [up(B)], storedKnown: [A, B], fromStart: true, resync: "view", ownIds: new Set([A, B]) });
	assert.deepEqual([...view.leftView], [], "a view reset stubs; it puts nothing on leftView");
});

test("the notices: hidden and out of view, each its own sentence", () => {
	assert.deepEqual(hiddenNotices(0, 0), []);
	assert.deepEqual(hiddenNotices(2, 0), ["2 elements were hidden by the world's owner; their fields were emptied from your notes."]);
	assert.deepEqual(hiddenNotices(1, 0), ["1 element was hidden by the world's owner; its fields were emptied from your note."]);
	assert.deepEqual(hiddenNotices(0, 3), ["3 elements left your view; their fields were emptied from your notes."]);
	assert.deepEqual(hiddenNotices(0, 1), ["1 element left your view; its fields were emptied from your note."]);
});

test("isHiddenId reads every world's hidden list", () => {
	assert.equal(isHiddenId({ hiddenOnServer: { w1: [B], w2: [A] } }, A), true);
	assert.equal(isHiddenId({ hiddenOnServer: { w1: [B] } }, A), false);
	assert.equal(isHiddenId({}, A), false);
});

test("★ the 409's reason, inside the error envelope or beside it", async () => {
	const answers = [
		{ error: { code: "resync_required", message: "m", reason: "view" } },
		{ error: { code: "resync_required", message: "m" }, reason: "role" },
		{ error: { code: "resync_required", message: "m" } },
	];
	const got: (string | null)[] = [];
	for (const body of answers) {
		setRequestUrl(() => ({ status: 409, json: body }));
		try {
			await new V2Client("ow_k_test", "1234").changesWalk("c5");
			assert.fail("no error");
		} catch (e) {
			got.push(resyncReasonOf(e));
		}
	}
	assert.deepEqual(got, ["view", "role", "none"]);
	assert.equal(resyncReasonOf(new V2ApiError(404, "not_found", "m", null)), null);
	assert.equal(resyncReasonOf(new Error("x")), null);
});
