/**
 * Route `require("obsidian")` to ./obsidian-mock for the rest of this process.
 *
 * The real `obsidian` package ships type declarations only — there is no
 * runtime module to load outside the app. Import this file FIRST in any test
 * that exercises Obsidian-facing code (vault/element-file.ts, Commands/*), so
 * the modules under test pick up the mock when they are required after it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
const Module = require("module");

const mockPath = require.resolve("./obsidian-mock");
const original = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
	if (request === "obsidian") return mockPath;
	return original.call(this, request, ...rest);
};

export {};
