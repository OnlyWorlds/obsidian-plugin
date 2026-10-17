/**
 * Resolve the baseUrl-style bare imports (`enums`, `Modals/...`) that esbuild
 * resolves in the build but node's test runner does not, so a test can load
 * Copy World. Import it right after ./obsidian-shim. From Kael's seam probe
 * (rc-350, 2026-10-17).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require("module") as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path") as { join: (...p: string[]) => string };
const root = path.join(__dirname, "..", "..");
const orig = M._resolveFilename;
M._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
	if (/^(enums|Modals\/|Scripts\/|Commands\/|vault\/|Listeners\/|settings\/)/.test(request)) {
		return orig.call(this, path.join(root, request), ...rest);
	}
	return orig.call(this, request, ...rest);
};
export {};
