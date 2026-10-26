/**
 * The test build's two bundles, run by `pretest` after tsc (3.10):
 *
 * 1. @onlyworlds/sdk 4.x is ESM only (a sealed `exports` map with no
 *    `require` entry), and the tests are compiled to CommonJS, so a test's
 *    `require("@onlyworlds/sdk")` would refuse. esbuild bundles the installed
 *    SDK into one CommonJS file at test-dist/node_modules/@onlyworlds/sdk,
 *    which Node's lookup finds from test-dist before the root node_modules.
 *    The same SDK bytes, the same tool and format the plugin build uses.
 * 2. The plugin itself, with the build's own options (esbuild.options.mjs),
 *    to test-dist/main.js, which test/bundle.test.ts loads: the proof that
 *    the ESM SDK bundles into a main.js Obsidian can load.
 */
import esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginBuildOptions } from "../../esbuild.options.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkDir = join(root, "test-dist", "node_modules", "@onlyworlds", "sdk");
mkdirSync(sdkDir, { recursive: true });

await esbuild.build({
	stdin: { contents: 'export * from "@onlyworlds/sdk";', resolveDir: root, loader: "js" },
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2022",
	outfile: join(sdkDir, "index.js"),
	logLevel: "warning",
});
writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@onlyworlds/sdk", main: "index.js" }) + "\n");

await esbuild.build({
	...pluginBuildOptions(true, join(root, "test-dist", "main.js")),
	absWorkingDir: root,
	logLevel: "warning",
});
