/**
 * Route `require("obsidian")` to ./obsidian-mock for the rest of this process.
 *
 * The real `obsidian` package ships type declarations only — there is no
 * runtime module to load outside the app. Import this file FIRST in any test
 * that exercises Obsidian-facing code (vault/element-file.ts, Commands/*), so
 * the modules under test pick up the mock when they are required after it.
 */
// `_resolveFilename` is Node's internal, untyped resolver hook.
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, import/no-nodejs-modules
const Module = require("module") as { _resolveFilename: (request: string, ...rest: unknown[]) => string };

// eslint-disable-next-line no-undef
const mockPath = require.resolve("./obsidian-mock");
const original = Module._resolveFilename;
Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
	if (request === "obsidian") return mockPath;
	return original.call(this, request, ...rest);
};

export {};
