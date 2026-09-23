/**
 * Extension-value round trip — a data-loss regression found by the hop-9
 * measurement (2026-09-23), run against the REAL Obsidian-facing wiring through
 * an in-memory vault (test/support/obsidian-mock.ts — its header says what it
 * emulates).
 *
 * ★ An `x_` extension value that is a list of OBJECTS (Sikelia's `x_inputs`
 * recipe rows, `x_wants`) was serialized item-by-item through the scalar
 * writer: every object became the string "[object Object]" and every null item
 * became "". The data was gone after one import.
 *
 * The YAML side runs under BOTH js-yaml 4 and yaml 2 (the two parsers in
 * node_modules; which one Obsidian's parseYaml behaves like is not known here).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
const mock = require("./support/obsidian-mock");
import { serializeFrontmatter, frontmatterToPayloadFields } from "../vault/element-transform";
import { writeElement, readElement } from "../vault/element-file";

const PARSERS = ["js-yaml", "yaml"] as const;

/** Every value shape an `x_` key can hold that JSON can carry. */
const EXTENSION_VALUES: Record<string, unknown> = {
	// Sikelia's real shapes (hop-9: destroyed to "[object Object]")
	x_inputs: [
		{ good: "7a54c1de-0000-4000-8000-000000000001", weight: 9 },
		{ good: "7a54c1de-0000-4000-8000-000000000002", weight: 1 },
		{ good: "7a54c1de-0000-4000-8000-000000000003", weight: 2 },
	],
	x_wants: [{ pays: 300, thing: "Bronze cuirass", amount: 1 }],
	// the synthetic stress shapes
	x_list_obj: [{ k: 1 }, { k: 2 }],
	x_list_mixed: [1, "two", null, true],
	x_null_items: [null, null],
	x_list_nested: [[1, 2], [], ["a", { deep: [null, false] }]],
	x_nested: { a: { b: [1, { c: null }] }, e: "", f: [] },
	x_empty_obj: {},
	// awkward strings INSIDE structures: quotes, colons, hashes, newlines,
	// date-likes, yes/no, non-ASCII — all must come back as the same strings
	x_awkward: [
		{ s: 'he said "hi": ok #1', d: "2024-01-01", y: "yes", n: "null", m: "line1\nline2" },
		"Συρακοῦσαι ☀",
		"[[Syracuse]]",
	],
	// plain scalars (these already survived; kept as a guard)
	x_int: 0,
	x_float: 3.5,
	x_bool: false,
	x_str_list: ["alpha", "beta"],
	x_num_list: [1, 2.5, -3],
};

function parse(parser: (typeof PARSERS)[number], block: string): Record<string, unknown> {
	mock.setYamlParser(parser);
	try {
		return mock.parseYaml(block.replace(/^---\n/, "").replace(/\n---$/, "\n"));
	} finally {
		mock.setYamlParser("js-yaml");
	}
}

for (const parser of PARSERS) {
	test(`★ x_ values of every shape survive serializeFrontmatter -> YAML (${parser}) -> payload`, () => {
		const fm = { name: "Bronze smelting", id: "c-1", ...EXTENSION_VALUES };
		const back = parse(parser, serializeFrontmatter(fm));
		const payload = frontmatterToPayloadFields(back, "construct");
		for (const [k, v] of Object.entries(EXTENSION_VALUES)) {
			assert.deepEqual(payload[k], v, `${k} changed on the round trip`);
		}
	});
}

test("link lists and plain string/number lists keep their block-list bytes (no churn)", () => {
	const block = serializeFrontmatter({
		name: "Ireena",
		id: "c-1",
		traits: ["[[Brave]]", "[[Kind]]"],
		x_str_list: ["alpha", "beta"],
		x_num_list: [1, 2],
	});
	assert.equal(
		block,
		[
			"---",
			"name: Ireena",
			"id: c-1",
			"traits:",
			'  - "[[Brave]]"',
			'  - "[[Kind]]"',
			"x_str_list:",
			"  - alpha",
			"  - beta",
			"x_num_list:",
			"  - 1",
			"  - 2",
			"---",
		].join("\n")
	);
});

for (const parser of PARSERS) {
	test(`★ writeElement -> readElement keeps x_inputs / x_wants intact, twice over (${parser})`, async () => {
		mock.setYamlParser(parser);
		try {
			const app = new mock.App();
			const id = "019a0000-0000-7000-8000-000000000001";
			const data = { id, name: "Bronze smelting", description: "Copper and tin.", ...EXTENSION_VALUES };
			const file = await writeElement(app, "W", "construct", id, data);
			const first = await readElement(app, file);
			assert.ok(first, "note did not read back");
			for (const [k, v] of Object.entries(EXTENSION_VALUES)) {
				assert.deepEqual(first!.fields[k], v, `${k} changed after one write/read`);
			}
			// a second trip (re-import of the export) must be stable too
			const again = await writeElement(app, "W", "construct", id, { id, ...first!.fields });
			const second = await readElement(app, again);
			for (const [k, v] of Object.entries(EXTENSION_VALUES)) {
				assert.deepEqual(second!.fields[k], v, `${k} changed after two write/reads`);
			}
		} finally {
			mock.setYamlParser("js-yaml");
		}
	});
}
