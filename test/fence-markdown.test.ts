/**
 * Round C fix round, item 1 (Kael's c-read, should-fix 1): the fence refusal
 * fired where nothing was cut short, at every auto-sync pause, and on notes
 * the plugin wrote itself (a server text with an odd `~~~` scene break).
 *
 * Now an unmatched fence line in a value is written escaped (`\~~~`, as
 * `### ` is) and read back without the backslash, so every value
 * round-trips. A save refuses only when an open fence swallows a `### `
 * heading, and the notice names the field and that heading. Fences follow
 * Markdown: at most three spaces of indent, a backtick fence closes only with
 * backticks and a tilde fence only with tildes, the closing run at least as
 * long as the opening one. Auto-sync shows the refusal once per note a session.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { buildElementBody, bodyToFieldValues, parseElementBody } from "../vault/element-transform";
import { readElement, writeElement } from "../vault/element-file";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000f1";
const fm = (name = "Ireena") => `---\nname: ${name}\nid: ${ID}\n---\n\n`;
const server = { [ID]: { name: "Ireena", description: "Old.", background: "Old." } };

test("★ a heading-less note with an open fence saves: nothing is swallowed", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": `${fm()}Some text.\n\`\`\`js\nlet x = 1;\n` },
		save: "Character/Ireena.md",
		server,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent[0]?.description, "Some text.\n```js\nlet x = 1;");
});

test("★ an open fence in the last section saves", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": `${fm()}### Description\n\nA noble.\n\n### Background\n\n\`\`\`js\nlet x = 1;\n`,
		},
		save: "Character/Ireena.md",
		server,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent[0]?.background, "```js\nlet x = 1;");
});

test("★ a `~~~` scene break from the server round-trips: the note escapes it and reads back exact", async () => {
	const { app, vault } = makeApp();
	const values = { description: "Scene one.\n~~~\nScene two.", background: "Later." };
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", ...values });
	const text = await vault.read(file as never);
	assert.ok(text.includes("Scene one.\n\\~~~\nScene two."), text);
	const parsed = await readElement(app, file as TFile);
	assert.ok(parsed);
	assert.equal(parsed.unclosedFence, undefined);
	assert.equal(parsed.fields.description, values.description);
	assert.equal(parsed.fields.background, values.background);
});

test("★ a `### ` heading inside an open fence refuses the save, naming the field and the heading", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md":
				`${fm()}### Description\n\nA.\n\n### Background\n\n~~~\ncode\n\n### Physicality\n\nTall.\n`,
		},
		save: "Character/Ireena.md",
		server,
	});
	assert.equal(r.result.ok, false);
	assert.deepEqual(r.sent, []);
	const n = r.notices.find((x) => /never closes/.test(x)) ?? "";
	assert.match(n, /Background/, r.notices.join(" | "));
	assert.match(n, /Physicality/, n);
});

test("★ a four-space-indented ``` is not a fence: the next section is still a field", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md":
				`${fm()}### Background\n\n    \`\`\`\n    code\n\n### Physicality\n\nTall.\n`,
		},
		save: "Character/Ireena.md",
		server,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent[0]?.background, "    ```\n    code");
	assert.equal(r.sent[0]?.physicality, "Tall.");
});

test("a backtick fence closes only with backticks, a tilde fence only with tildes, the closing run at least as long", () => {
	for (const block of ["```\n~~~\n```", "~~~\n```\n~~~", "````\n```\n````", "```\n````"]) {
		const body = `### Background\n\n${block}\n\n### Physicality\n\nTall.\n`;
		const parsed = parseElementBody(body, "character");
		assert.equal(parsed.unclosedFence, undefined, block);
		assert.equal(parsed.fields.background, block, block);
		assert.equal(parsed.fields.physicality, "Tall.", block);
	}
});

test("auto-sync shows the refusal once per note a session, not at every pause", async () => {
	const notes = {
		"Character/Fenced.md": `${fm("Fenced")}### Background\n\n\`\`\`\ncode\n\n### Physicality\n\nTall.\n`,
	};
	const first = await harnessSave({ notes, save: "Character/Fenced.md", server, manual: false });
	assert.equal(first.result.ok, false);
	assert.equal(first.notices.filter((n) => /never closes/.test(n)).length, 1, first.notices.join(" | "));
	const second = await harnessSave({ notes, save: "Character/Fenced.md", server, manual: false });
	assert.equal(second.result.ok, false);
	assert.deepEqual(second.notices.filter((n) => /never closes/.test(n)), [], "named again at the next pause");
	const manual = await harnessSave({ notes, save: "Character/Fenced.md", server });
	assert.equal(manual.notices.filter((n) => /never closes/.test(n)).length, 1, "the manual Save always says it");
});

test("★ every fence shape a value can hold round-trips byte for byte through a note", () => {
	const shapes = [
		"```",
		"~~~ scene\nB",
		"\\~~~ already escaped",
		"  \\\\```js twice",
		"  ```\n### x",
		"````\n```\n### in\n````\n### out",
		"```\nA\n~~~\nB",
		"a\r\n~~~\r\nb\r\n",
		"    ```\n### indented",
		"``` a`b\n### info with a backtick",
	];
	for (const v of shapes) {
		const body = `${buildElementBody({ description: v, background: "Next." }, "character")}\n`;
		const parsed = parseElementBody(body, "character");
		assert.equal(parsed.unclosedFence, undefined, JSON.stringify(v));
		const back = bodyToFieldValues(body, "character");
		assert.equal(back.description, v, JSON.stringify(v));
		assert.equal(back.background, "Next.", JSON.stringify(v));
	}
});

// The keeper's amendment (Kael's second read): one rule for a closed fence both ways.
test("★ a `### ` line inside a closed fence is written and read back unchanged, by one rule both ways", async () => {
	const value = "Before.\n```md\n### inside\n\\### typed inside\n```\nAfter.";
	const body = buildElementBody({ description: value, background: "Next." }, "character");
	assert.ok(body.includes("```md\n### inside\n\\### typed inside\n```"), body);
	const { app } = makeApp();
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", description: value, background: "Next." });
	const parsed = await readElement(app, file as TFile);
	assert.equal(parsed?.fields.description, value);
	assert.equal(parsed?.fields.background, "Next.");
	// A hand note: the closed fence's `### ` is no heading.
	const hand = parseElementBody("### Description\n\n~~~\n### not a field\n~~~\n\n### Background\n\nNext.\n", "character");
	assert.equal(hand.fields.description, "~~~\n### not a field\n~~~");
	assert.deepEqual(hand.unknown, []);
});
