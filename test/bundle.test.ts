/**
 * The plugin bundle loads (3.10). @onlyworlds/sdk 4.x is
 * ESM only; Obsidian loads one CommonJS `main.js`. `pretest` builds the
 * plugin with the build's own options (esbuild.options.mjs) to
 * test-dist/main.js (test/support/build-for-tests.mjs); this test loads that
 * bundle as Obsidian does, a CommonJS module whose only outside requires are
 * `obsidian` and Node's built-ins, and reads the SDK's table out of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import * as mock from "./support/obsidian-mock";

const BUNDLE = join(__dirname, "..", "main.js");

/** The mock, with the base classes main.js extends at load and the names it only uses at run time. */
function obsidianForLoad(): Record<string, unknown> {
	class Stub {}
	return { ...mock, Plugin: class Plugin {}, PluginSettingTab: class PluginSettingTab {}, MarkdownView: Stub, Menu: Stub, setIcon: () => {} };
}

test("★ the bundle is one CommonJS main.js with the ESM SDK inside: it loads with only obsidian and Node's built-ins outside", () => {
	const code = readFileSync(BUNDLE, "utf8");
	assert.ok(!/require\(["']@onlyworlds\/sdk["']\)/.test(code), "the SDK was left outside the bundle");
	assert.ok(!/^\s*(import|export)\s/m.test(code), "the bundle is not CommonJS");
	const asked: string[] = [];
	const req = (id: string): unknown => {
		asked.push(id);
		if (id === "obsidian") return obsidianForLoad();
		if (builtinModules.includes(id.replace(/^node:/, ""))) return require(id);
		throw new Error(`the bundle requires ${id}, which Obsidian does not provide`);
	};
	const module = { exports: {} as Record<string, unknown> };
	new Function("module", "exports", "require", code)(module, module.exports, req);
	const Plugin = module.exports.default as { prototype: Record<string, unknown> } | undefined;
	assert.equal(typeof Plugin, "function", "main.js exports no plugin class");
	assert.equal(typeof Plugin!.prototype.onload, "function");
	assert.ok(asked.includes("obsidian"));
});

test("★ the bundle carries the 4.x table, tree-shaken: Zone's `shape`, `integer` for whole numbers, none of the SDK's zip code", () => {
	const code = readFileSync(BUNDLE, "utf8");
	assert.ok(/shape:\s*\{\s*type:\s*"text"\s*\}/.test(code), "Zone's shape is not in the bundle");
	assert.ok(/height:\s*\{\s*type:\s*"integer"\s*\}/.test(code), "an `integer` field type is not in the bundle");
	// The plugin imports FIELD_SCHEMA alone; the SDK's world-file reader (fflate) stays out.
	assert.ok(!/inflateSync/.test(code), "the SDK's zip code was bundled");
	assert.ok(!/type:\s*"number"/.test(code), "a `number` field type is in the bundle");
});
