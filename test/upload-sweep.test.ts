/**
 * The upload sweep counts what keel answered, item by item — run against the
 * REAL ExportWorldCommand (collect + upload) through an in-memory vault, with
 * the v2 client's network methods stubbed on its prototype.
 *
 * ★ Row 9 of the data-paths ranking (OW Infra #166): after POST /bulk the
 * sweep set `created = toCreate.length` and never read the body. keel answers
 * /bulk with HTTP 200 ALWAYS and one result per item, in request order:
 * `{ errors, items: [{ status: 201 | 200 | <error status>, id, error? }] }`
 * (keel core/bulk_api.py BulkResult; elements/bulk.py _success_result,
 * _finalize_error_slots). A refused item was reported as created.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { V2Client } from "../client-v2";

const W = "OnlyWorlds/Worlds/W";
const IDS = {
	Akragas: "019a0000-0000-7000-8000-0000000000c1",
	Gela: "019a0000-0000-7000-8000-0000000000c2",
	Syracuse: "019a0000-0000-7000-8000-0000000000c3",
};
const note = (id: string, name: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nA city.\n`;

type Proto = Record<string, unknown>;
const proto = V2Client.prototype as unknown as Proto;
const saved: Proto = {};
for (const k of ["changesWalk", "bulkCreate", "update", "getWorld", "patchWorld"]) saved[k] = proto[k];
const restore = () => {
	for (const [k, v] of Object.entries(saved)) proto[k] = v;
};

async function sweep(bulkBody: unknown): Promise<{ notices: string[]; sent: unknown[] }> {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	for (const [name, id] of Object.entries(IDS)) {
		await vault.seed(`${W}/Elements/Location/${name}.md`, note(id, name));
	}
	const sent: unknown[] = [];
	proto.changesWalk = async () => ({ changes: [], cursor: null, head: 0 });
	proto.bulkCreate = async (items: unknown[]) => {
		sent.push(...items);
		return bulkBody;
	};
	proto.update = async () => ({});
	const cmd = new ExportWorldCommand(app, {} as never, new WorldService(app));
	const data = await cmd.collectWorldData("W");
	__notices.length = 0;
	try {
		await (cmd as unknown as { uploadViaV2(pin: number, w: string, d: unknown): Promise<void> }).uploadViaV2(1234, "W", data);
	} finally {
		restore();
	}
	return { notices: [...__notices], sent };
}

/** The result slots keel would send for `sent`, by name: 201 unless overridden. */
function bodyFor(sent: { element: { id: string; name: string } }[], override: Record<string, unknown>) {
	return {
		errors: Object.keys(override).length > 0,
		items: sent.map((it) => override[it.element.name] ?? { status: 201, id: it.element.id }),
	};
}

test("★ a /bulk item keel refused is counted failed and named, not created (row 9)", async () => {
	// Two passes: the first learns the request order, the second answers it.
	const probe = await sweep({ errors: false, items: [] });
	const order = probe.sent as { element: { id: string; name: string } }[];
	assert.equal(order.length, 3);
	const refusal = {
		status: 422,
		id: IDS.Gela,
		error: { type: "invalid_request_error", code: "invalid_request", message: "Unknown field: mood", param: "mood" },
	};
	const { notices } = await sweep(bodyFor(order, { Gela: refusal }));
	const summary = notices.find((n) => n.startsWith("Upload complete"));
	assert.ok(summary, `no summary in ${JSON.stringify(notices)}`);
	assert.match(summary, /\b2 created\b/);
	assert.match(summary, /\b1 failed\b/);
	const failure = notices.find((n) => /failed —/.test(n));
	assert.ok(failure, `no failure notice in ${JSON.stringify(notices)}`);
	assert.match(failure, /1 element failed/);
	assert.match(failure, /Gela/);
	assert.match(failure, /Unknown field: mood/);
});

test("a /bulk body with every item 201 counts every item created", async () => {
	const probe = await sweep({ errors: false, items: [] });
	const order = probe.sent as { element: { id: string; name: string } }[];
	const { notices } = await sweep(bodyFor(order, {}));
	const summary = notices.find((n) => n.startsWith("Upload complete")) ?? "";
	assert.match(summary, /\b3 created\b/);
	assert.ok(!notices.some((n) => /failed/.test(n)), JSON.stringify(notices));
});

test("a /bulk body missing results never counts the missing items as created", async () => {
	const { notices } = await sweep({ errors: false });
	const summary = notices.find((n) => n.startsWith("Upload complete")) ?? "";
	assert.match(summary, /\b0 created\b/);
	assert.ok(notices.some((n) => /3 elements failed/.test(n)), JSON.stringify(notices));
});
