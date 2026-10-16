/**
 * String fields survive the frontmatter round trip as the same strings — run
 * against the REAL writeElement / readElement through an in-memory vault, under
 * BOTH js-yaml 4 (what Obsidian ships, read off its asar in hop 10) and yaml 2.
 *
 * ★ Row 3 of the data-paths ranking (OW Infra #166, hop 9 #8): the scalar
 * writer left `2024-01-01` plain, so it came back a timestamp; ` #` started a
 * YAML comment and cut the value; `1e3` came back the number 1000; a newline
 * inside a quoted value broke the whole block, so the note could not be read
 * and the save failed.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp, setYamlParser } from "./support/obsidian-mock";
import { writeElement, readElement } from "../vault/element-file";
import { parseRawFrontmatterScalars } from "../vault/element-transform";

const PARSERS = ["js-yaml", "yaml"] as const;
const ID = "019a0000-0000-7000-8000-0000000000d1";

/** Each case: the string fields one element carries. */
const CASES: Record<string, Record<string, string>> = {
	"a date-like supertype": { name: "Founding", supertype: "2024-01-01" },
	"a name with ` #`": { name: "The Hall #3", supertype: "hall" },
	"subtype yes": { name: "Assent", subtype: "yes" },
	"subtype no": { name: "Refusal", subtype: "no" },
	"a number-like supertype": { name: "Thousand", supertype: "1e3" },
	"a multi-line value": { name: "Two lines", subtype: "line one\nline two" },
	"an image_url with ` #`": { name: "Pictured", image_url: "https://example.org/a b #2.png" },
	"quotes, backslashes and a tab": { name: 'He said "hi" \\ there', supertype: "tab\there" },
};

for (const parser of PARSERS) {
	for (const [label, strings] of Object.entries(CASES)) {
		test(`★ ${label} round-trips write -> read unchanged (${parser})`, async () => {
			setYamlParser(parser);
			try {
				const { app } = makeApp();
				const file = await writeElement(app, "W", "location", ID, { ...strings });
				const back = await readElement(app, file);
				assert.ok(back, "the note could not be read back");
				for (const [k, v] of Object.entries(strings)) {
					assert.equal(back.fields[k], v, `${k} changed on the round trip`);
				}
			} finally {
				setYamlParser("js-yaml");
			}
		});
	}
}

test("★ a note already on disk with a plain date supertype reads back as the string", async () => {
	// Written before the fix, or typed by hand: js-yaml reads it as a Date.
	const { app, vault } = makeApp();
	const file = await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Location/Founding.md",
		`---\nname: Founding\nid: ${ID}\nsupertype: 2024-01-01\n---\n\n### Description\n\n`
	);
	const back = await readElement(app, file as unknown as TFile);
	assert.equal(back?.fields.supertype, "2024-01-01");
});

test("★ a text field YAML read as a number or boolean leaves as the string typed; a number field stays a number", async () => {
	// Hand-typed: `supertype: 5` and `subtype: true` parse as 5 and true.
	const { app, vault } = makeApp();
	const file = await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Character/Five.md",
		`---\nname: Five\nid: ${ID}\nsupertype: 5\nsubtype: true\nheight: 5\n---\n\n### Description\n\n`
	);
	const back = await readElement(app, file as unknown as TFile);
	assert.equal(back?.fields.supertype, "5");
	assert.equal(back?.fields.subtype, "true");
	assert.equal(back?.fields.height, 5);
});

test("the raw frontmatter scanner unescapes a double-quoted value", () => {
	const content = `---\nname: "He said \\"hi\\" \\\\ there"\nid: ${ID}\n---\n`;
	assert.equal(parseRawFrontmatterScalars(content, ["name"]).name, 'He said "hi" \\ there');
});
