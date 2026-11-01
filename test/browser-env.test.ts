/**
 * What Sign in with your browser runs on, desktop and phone: the phone has no loopback listener
 * (it never loads Node's http; the obsidian:// return carries the sign-in back) and the desktop has
 * one. The button is offered on both: the plugin's browserEnv() is never null.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "./support/obsidian-mock";
import { makeBrowserEnv, type BrowserHost } from "../account/browser-env";

function host(): BrowserHost {
	return {
		settings: { accountToken: "", accountUsername: "", pendingSignIn: "" },
		saveSettings: async () => undefined,
	};
}

test("on a phone the env has no loopback listener, and the browser opens the page", () => {
	const was = Platform.isMobile;
	Platform.isMobile = true;
	try {
		const env = makeBrowserEnv(host());
		assert.equal(env.listen, undefined, "a phone returns through obsidian://, never through a local port");
		assert.equal(typeof env.openUrl, "function");
		assert.equal(typeof env.fetch, "function");
	} finally {
		Platform.isMobile = was;
	}
});

test("on desktop the env carries the loopback listener", () => {
	const was = Platform.isMobile;
	Platform.isMobile = false;
	try {
		const env = makeBrowserEnv(host());
		assert.equal(typeof env.listen, "function");
	} finally {
		Platform.isMobile = was;
	}
});

test("the plugin offers the button on both platforms: main.ts no longer gates browserEnv on the platform", async () => {
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const src = readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8");
	const m = /browserEnv\(\)[^{]*\{([\s\S]*?)\n\s*\}/.exec(src);
	assert.ok(m, "browserEnv() is in main.ts");
	assert.ok(!/Platform\.isMobile/.test(m[1]), "browserEnv() must not return null on a phone");
	assert.match(m[1], /makeBrowserEnv\(this\)/);
});
