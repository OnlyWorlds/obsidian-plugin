/**
 * What Sign in with your browser runs on, desktop and phone: the phone has no loopback listener
 * (it never loads Node's http; the obsidian:// return carries the sign-in back) and the desktop has
 * one. The button is offered on both: the plugin's browserEnv() is never null.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { Platform, __notices } from "./support/obsidian-mock";
import { handleSchemeReturn, makeBrowserEnv, type BrowserHost } from "../account/browser-env";
import { beginBrowserSignIn, SIGN_IN_CANCELLED_IN_BROWSER, waitForSchemeReturn } from "../account/browser-sign-in";

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

/** A phone sign-in started and parked: the host, and the state the browser page was sent with. */
async function parkedOnPhone(): Promise<{ h: BrowserHost; state: string }> {
	const was = Platform.isMobile;
	Platform.isMobile = true;
	try {
		const h = host();
		const urls: string[] = [];
		await beginBrowserSignIn({ ...makeBrowserEnv(h), openUrl: (u: string) => urls.push(u) });
		assert.ok(h.settings.pendingSignIn, "the obsidian:// path parks the record in the plugin's data");
		return { h, state: new URL(urls[0]).searchParams.get("state")! };
	} finally {
		Platform.isMobile = was;
	}
}

test("handleSchemeReturn: a link with another state is ignored, the parked sign-in stays and nothing is said", async () => {
	const { h } = await parkedOnPhone();
	const parked = h.settings.pendingSignIn;
	__notices.length = 0;
	await handleSchemeReturn(h, { action: "onlyworlds-signin", code: "c", state: "not-the-parked-one" });
	assert.equal(h.settings.pendingSignIn, parked, "the SDK never saw the forged link, so the record is untouched");
	assert.deepEqual(__notices, []);
});

test("handleSchemeReturn: with nothing parked a return does nothing at all (no request, no notice)", async () => {
	const h = host();
	__notices.length = 0;
	await handleSchemeReturn(h, { action: "onlyworlds-signin", code: "c", state: "anything" });
	assert.deepEqual(__notices, []);
	assert.equal(h.settings.pendingSignIn, "");
});

test("handleSchemeReturn: a dialog that is waiting takes the address, and the parked record is left for its exchange", async () => {
	const { h, state } = await parkedOnPhone();
	const parked = h.settings.pendingSignIn;
	const wait = waitForSchemeReturn();
	__notices.length = 0;
	await handleSchemeReturn(h, { action: "onlyworlds-signin", code: "c", state });
	assert.match(await wait.url, /^obsidian:\/\/onlyworlds-signin\?code=c&state=/);
	assert.equal(h.settings.pendingSignIn, parked);
	assert.deepEqual(__notices, [], "the dialog, not a notice, finishes the sign-in");
	wait.cancel();
});

test("handleSchemeReturn: with no dialog, a return the person cancelled in the browser clears the record and says so", async () => {
	const { h, state } = await parkedOnPhone();
	__notices.length = 0;
	await handleSchemeReturn(h, { action: "onlyworlds-signin", error: "access_denied", state });
	assert.equal(h.settings.pendingSignIn, "");
	assert.deepEqual(__notices, [SIGN_IN_CANCELLED_IN_BROWSER]);
});
