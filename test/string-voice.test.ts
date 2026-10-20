/**
 * The plugin's words against the house rules (OW Infra #452; Seethe's flags
 * F-33..F-36, Carrier\Studio\style\RULES.md sections 1 and 3):
 *   - no ALL-CAPS button label in Modals/ (PIN is an acronym and stays);
 *   - no "Please" and no exclamation mark in any message;
 *   - command names in sentence case, and every command id unchanged (users'
 *     hotkeys bind to the id, so an id may never move).
 *
 * ⚑ BLIND SPOTS (a source scan, not a run of the plugin):
 *   - it reads single-line string literals only: a message split across lines
 *     or concatenated from fragments, a multi-line template literal, and text
 *     read from a file or the server at run time are not seen;
 *   - "ALL CAPS" is judged on a whole literal (CANCEL, TAKE ONLINE), so a
 *     caps word inside a longer sentence is not caught;
 *   - it cannot tell a user-facing literal from a code literal: the few
 *     allowances below (HTTP verbs, ability scores, a markdown image) are the
 *     code literals that happen to look like violations;
 *   - sentence case of headings and labels (F-34) is checked for command
 *     names only, not for every label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// test-dist/test/<this file>.js -> the repo root
const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "test", "test-dist", ".git", "docs"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) sourceFiles(p, out);
		else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

interface Lit { file: string; line: number; text: string; code: string }

const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g;

function literals(files: string[]): Lit[] {
	const out: Lit[] = [];
	for (const file of files) {
		const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
		lines.forEach((l, i) => {
			if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // a comment line
			LITERAL.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = LITERAL.exec(l))) {
				const text = m[1] ?? m[2] ?? m[3] ?? "";
				out.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), line: i + 1, text, code: l });
			}
		});
	}
	return out;
}

const ALL = sourceFiles(ROOT);
const LITS = literals(ALL);
const where = (l: Lit) => `${l.file}:${l.line} ${JSON.stringify(l.text)}`;

test("no ALL-CAPS button label in Modals/ (PIN stays)", () => {
	const caps = /^[A-Z][A-Z\- ]*[A-Z]$/; // two or more letters, nothing lower-case
	const bad = LITS.filter((l) => l.file.startsWith("Modals/") && caps.test(l.text) && l.text !== "PIN");
	assert.deepEqual(bad.map(where), []);
});

test('no "Please" in any message', () => {
	const bad = LITS.filter((l) => /\bplease\b/i.test(l.text));
	assert.deepEqual(bad.map(where), []);
});

test('no "Failed to" and no "successfully" in a message (RULES section 3)', () => {
	// An error names what did not happen ("Could not create the world"); a success
	// drops the word ("World downloaded: X"). Exempt: console.* lines (a log, not
	// a message) and `.includes(` lines (code matching the browser's own
	// "Failed to fetch" text).
	const bad = LITS.filter(
		(l) => /failed to|successfully/i.test(l.text) && !/console\.|\.includes\(/.test(l.code),
	);
	assert.deepEqual(bad.map(where), []);
});

test("no exclamation mark in any message", () => {
	// Allowed: the status bar's "OW !" sync glyph (a marker, not a sentence) and a
	// markdown image (`![alt](url)`); `!` as the not-operator sits outside literals.
	// `${...}` interpolations are code, so `!` inside one (a not-operator) is cut first.
	const prose = (l: Lit) => l.text.replace(/\$\{[^}]*\}/g, "");
	const bad = LITS.filter((l) => prose(l).includes("!") && l.text !== "OW !" && !l.text.includes("!["));
	assert.deepEqual(bad.map(where), []);
});

test("command ids are unchanged (hotkeys bind to them)", () => {
	const main = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
	const ids = [...main.matchAll(/^\s*id:\s*['"`]([^'"`]+)['"`]/gm)].map((m) => m[1]);
	assert.deepEqual(ids, [
		"export-world",
		"download-world",
		"join-world-link",
		"create-world",
		"create-element",
		"validate-world",
		"write-bases-file",
		"draw-relationships-canvas",
		"paste-world",
		"copy-world",
		"rename-world",
		"save-element",
		"delete-element",
		"migrate-world-frontmatter",
		"update-world-format",
		"export-onlyworlds-folder",
		"import-onlyworlds-folder",
		"link-elements",
		"manage-fields",
		"add-custom-field",
		"create-new-${category.toLowerCase()}",
	]);
});

test("command names are in sentence case", () => {
	const main = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
	const names = [...main.matchAll(/^\s*name:\s*['"`]([^'"`]+)['"`]/gm)].map((m) => m[1]);
	assert.ok(names.length >= 20, "found the command names");
	const proper = new Set(["OnlyWorlds", "Bases"]); // a product name and an Obsidian feature
	const bad = names.filter((n) => {
		const words = n.split(/\s+/);
		return !/^[A-Z]/.test(words[0]) || words.slice(1).some((w) => /^[A-Z]/.test(w) && !proper.has(w));
	});
	assert.deepEqual(bad, []);
});
