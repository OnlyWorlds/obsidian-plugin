/**
 * Sign in with your browser, the pure layer: the two return addresses, the pending
 * record, the words for what went wrong, the desktop loopback listener (Node's own
 * http, a free port, no Obsidian) and the whole round trip through the real SDK
 * with a stand-in for keel's token route. Nothing here reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { OwSignInError } from "@onlyworlds/sdk";
import {
	SCHEME_RETURN,
	SIGN_IN_TIMEOUT,
	beginBrowserSignIn,
	completeFromUrl,
	loopbackReturn,
	SIGN_IN_CANCELLED_IN_BROWSER,
	pendingStorage,
	peekPending,
	receiveSchemeReturn,
	schemeReturnIsExpected,
	schemeReturnUrl,
	signInFailure,
	waitForSchemeReturn,
	type BrowserSignInEnv,
	type PendingHolder,
} from "../account/browser-sign-in";
import { listenOnce } from "../account/loopback-listener";

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function refused(port: number): Promise<boolean> {
	return get(port, "/").then(
		() => false,
		(e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED"
	);
}

// --- the addresses ----------------------------------------------------------

test("the loopback return carries the port and the registered path, nothing else", () => {
	assert.equal(loopbackReturn(53682), "http://127.0.0.1:53682/onlyworlds-signin");
});

test("the scheme return is rebuilt from the handler's parameters, without the action", () => {
	assert.equal(schemeReturnUrl({ action: "onlyworlds-signin", code: "abc", state: "s 1" }), "obsidian://onlyworlds-signin?code=abc&state=s+1");
	assert.equal(schemeReturnUrl({ action: "onlyworlds-signin" }), SCHEME_RETURN);
});

// --- the pending record ------------------------------------------------------

test("the pending record lives in the holder, expires, and leaves nothing behind", () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	let saves = 0;
	let t = 1_000;
	const s = pendingStorage(holder, () => saves++, () => t, 5_000);
	assert.equal(s.get("k"), null);
	s.set("k", "v");
	assert.equal(s.get("k"), "v");
	assert.ok(holder.pendingSignIn.includes('"k"'), "the record is in the plugin's data");
	t += 4_999;
	assert.equal(s.get("k"), "v", "still valid at the edge");
	t += 2;
	assert.equal(s.get("k"), null, "gone after the time limit");
	assert.equal(holder.pendingSignIn, "", "and cleared from the data");
	s.set("a", "1");
	s.remove("a");
	assert.equal(holder.pendingSignIn, "", "the last key removed leaves an empty record");
	s.set("b", "2");
	s.clear();
	assert.equal(s.get("b"), null);
	assert.equal(holder.pendingSignIn, "");
	assert.ok(saves > 0, "every change was saved");
});

test("a damaged record reads as nothing pending", () => {
	const holder: PendingHolder = { pendingSignIn: "{not json" };
	const s = pendingStorage(holder, () => undefined);
	assert.equal(s.get("k"), null);
	s.set("k", "v");
	assert.equal(s.get("k"), "v");
});

// --- the words ----------------------------------------------------------------

test("what went wrong is said in the house words: what did not happen", () => {
	assert.match(signInFailure(new OwSignInError("rate_limited", "x")).message, /^Too many sign-in attempts, so nothing was saved\./);
	assert.match(signInFailure(new OwSignInError("offline", "x")).message, /could not be reached, so nothing was saved/);
	for (const reason of ["state_mismatch", "invalid_grant", "failed"] as const) {
		assert.match(signInFailure(new OwSignInError(reason, "x")).message, /did not accept that sign-in, so nothing was saved/);
	}
	assert.equal(signInFailure(new Error("timeout")).message, SIGN_IN_TIMEOUT);
	assert.equal(signInFailure(new Error("cancelled")).message, SIGN_IN_TIMEOUT);
	assert.equal(signInFailure("odd").message, SIGN_IN_TIMEOUT);
	for (const m of [SIGN_IN_TIMEOUT]) assert.ok(!/please|!/i.test(m));
});

// --- the loopback listener ------------------------------------------------------

test("the listener answers one right request, hands back the address with its query, and closes", async () => {
	const l = await listenOnce({ timeoutMs: 5_000 });
	assert.ok(l.port > 0);
	l.expect("s1");
	const r = await get(l.port, "/onlyworlds-signin?code=c1&state=s1", { host: `127.0.0.1:${l.port}` });
	assert.equal(r.status, 200);
	assert.match(r.body, /You can close this tab/);
	assert.equal(await l.done, `http://127.0.0.1:${l.port}/onlyworlds-signin?code=c1&state=s1`);
	await new Promise((r2) => setTimeout(r2, 50));
	assert.ok(await refused(l.port), "the port is closed after the answer");
});

test("a wrong path, method, Host header or state is a 404 and the wait goes on", async () => {
	const l = await listenOnce({ timeoutMs: 5_000 });
	const own = { host: `127.0.0.1:${l.port}` };
	assert.equal((await get(l.port, "/onlyworlds-signin?code=x&state=ok", own)).status, 404, "before the state is known every request is a 404");
	l.expect("ok");
	assert.equal((await get(l.port, "/other?code=x&state=ok", own)).status, 404);
	assert.equal((await get(l.port, "/onlyworlds-signin?code=x&state=ok", own, "POST")).status, 404);
	assert.equal((await get(l.port, "/onlyworlds-signin?code=x&state=ok", { host: "evil.example" })).status, 404);
	assert.equal((await get(l.port, "/onlyworlds-signin?code=x&state=ok", { host: `localhost:${l.port}` })).status, 404);
	assert.equal((await get(l.port, "/onlyworlds-signin", own)).status, 404, "no state at all");
	assert.equal((await get(l.port, "/onlyworlds-signin?code=x&state=forged", own)).status, 404, "another state");
	let settled = false;
	void l.done.then(() => (settled = true), () => (settled = true));
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(settled, false, "none of those ended the wait");
	assert.equal((await get(l.port, "/onlyworlds-signin?code=ok&state=ok", own)).status, 200);
	assert.match(await l.done, /code=ok&state=ok$/);
});

test("the timer closes the listener", async () => {
	const l = await listenOnce({ timeoutMs: 40 });
	await assert.rejects(l.done, /timeout/);
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(await refused(l.port));
});

test("cancelling closes the listener and ends the wait", async () => {
	const l = await listenOnce({ timeoutMs: 5_000 });
	l.close();
	await assert.rejects(l.done, /cancelled/);
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(await refused(l.port));
	l.close(); // a second close is harmless
});

// --- the whole round trip, through the real SDK ------------------------------------

/** keel's token route, as far as the SDK reads it: the code, the verifier and the address must come back as sent. */
function keelFetch(log: { body: Record<string, string> }[], answer: { status: number; json: unknown }): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		assert.equal(url, "https://www.onlyworlds.com/api/v2/auth/token");
		assert.equal(init?.method, "POST");
		log.push({ body: JSON.parse(String(init?.body)) as Record<string, string> });
		return {
			ok: answer.status >= 200 && answer.status < 300,
			status: answer.status,
			headers: { get: () => null },
			json: async () => answer.json,
		} as unknown as Response;
	}) as typeof fetch;
}

function env(holder: PendingHolder, fetchImpl: typeof fetch, opened: string[], listen = true): BrowserSignInEnv {
	return {
		fetch: fetchImpl,
		storage: pendingStorage(holder, () => undefined),
		openUrl: (u) => opened.push(u),
		listen: listen ? listenOnce : undefined,
	};
}

test("desktop: the browser comes back to the loopback and the token comes out; nothing is left pending", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const log: { body: Record<string, string> }[] = [];
	const e = env(holder, keelFetch(log, { status: 200, json: { token: "ow_a_fromkeel", account: { id: "acc-1", username: "tess" } } }), opened);
	const s = await beginBrowserSignIn(e);
	assert.equal(s.via, "loopback");
	assert.equal(opened.length, 1, "the browser was sent once");
	const auth = new URL(opened[0]);
	assert.equal(auth.origin + auth.pathname, "https://www.onlyworlds.com/signin/authorize");
	assert.equal(auth.searchParams.get("client_id"), "obsidian");
	assert.match(auth.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/onlyworlds-signin$/);
	assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
	assert.equal(holder.pendingSignIn, "", "on the loopback path the state and verifier stay in memory, not in the plugin's data");
	// the browser comes back
	const back = new URL(auth.searchParams.get("redirect_uri") as string);
	const r = await get(Number(back.port), `${back.pathname}?code=thecode&state=${auth.searchParams.get("state")}`, { host: back.host });
	assert.equal(r.status, 200);
	assert.equal(await (s.finished as Promise<string>), "ow_a_fromkeel");
	assert.equal(log.length, 1);
	assert.equal(log[0].body.code, "thecode");
	assert.equal(log[0].body.client_id, "obsidian");
	assert.equal(log[0].body.redirect_uri, auth.searchParams.get("redirect_uri"), "the exchange names the address the sign-in started with");
	assert.equal(holder.pendingSignIn, "", "nothing left pending");
});

test("desktop: a stray request or a forged return does not end the wait; the real return still signs in", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const log: { body: Record<string, string> }[] = [];
	const s = await beginBrowserSignIn(env(holder, keelFetch(log, { status: 200, json: { token: "ow_a_real", account: { id: "a", username: "t" } } }), opened));
	const auth = new URL(opened[0]);
	const back = new URL(auth.searchParams.get("redirect_uri") as string);
	const own = { host: back.host };
	assert.equal((await get(Number(back.port), `${back.pathname}`, own)).status, 404, "a bare request to the return path");
	assert.equal((await get(Number(back.port), `${back.pathname}?code=c&state=forged`, own)).status, 404, "a forged state");
	assert.equal(log.length, 0, "nothing was traded");
	assert.equal((await get(Number(back.port), `${back.pathname}?code=c&state=${auth.searchParams.get("state")}`, own)).status, 200);
	assert.equal(await (s.finished as Promise<string>), "ow_a_real");
	assert.equal(log.length, 1);
});

test("desktop: Cancel on keel's page (an error return) ends the attempt in its own words and trades nothing", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const log: { body: Record<string, string> }[] = [];
	const s = await beginBrowserSignIn(env(holder, keelFetch(log, { status: 200, json: {} }), opened));
	const auth = new URL(opened[0]);
	const back = new URL(auth.searchParams.get("redirect_uri") as string);
	void get(Number(back.port), `${back.pathname}?error=access_denied&state=${auth.searchParams.get("state")}`, { host: back.host });
	await assert.rejects(s.finished as Promise<string>, new RegExp(SIGN_IN_CANCELLED_IN_BROWSER.slice(0, 30)));
	assert.equal(log.length, 0);
});

test("desktop: keel refusing the code is said in the house words and leaves nothing pending", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const log: { body: Record<string, string> }[] = [];
	const s = await beginBrowserSignIn(env(holder, keelFetch(log, { status: 400, json: { error: { code: "invalid_grant", message: "used" } } }), opened));
	const auth = new URL(opened[0]);
	const back = new URL(auth.searchParams.get("redirect_uri") as string);
	void get(Number(back.port), `${back.pathname}?code=c&state=${auth.searchParams.get("state")}`, { host: back.host });
	await assert.rejects(s.finished as Promise<string>, /did not accept that sign-in, so nothing was saved/);
	assert.equal(log.length, 1);
	assert.equal(holder.pendingSignIn, "");
});

test("desktop: cancelling closes the port and clears the record", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const s = await beginBrowserSignIn(env(holder, keelFetch([], { status: 200, json: {} }), opened));
	const port = Number(new URL(new URL(opened[0]).searchParams.get("redirect_uri") as string).port);
	s.cancel();
	await assert.rejects(s.finished as Promise<string>, new RegExp(SIGN_IN_TIMEOUT.slice(0, 20)));
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(await refused(port));
	assert.equal(holder.pendingSignIn, "");
});

test("mobile: no listener, the obsidian:// return is the address, and the protocol handler completes it", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const log: { body: Record<string, string> }[] = [];
	const e = env(holder, keelFetch(log, { status: 200, json: { token: "ow_a_phone", account: { id: "acc-2", username: "tess" } } }), opened, false);
	const s = await beginBrowserSignIn(e);
	assert.equal(s.via, "scheme");
	assert.equal(s.finished, null);
	const auth = new URL(opened[0]);
	assert.equal(auth.searchParams.get("redirect_uri"), SCHEME_RETURN);
	assert.ok(holder.pendingSignIn.length > 0, "on the obsidian:// path the sign-in is parked in the plugin's data (the phone may restart Obsidian)");
	// no dialog is waiting (the phone restarted Obsidian): the handler finishes it from the parked record
	const url = schemeReturnUrl({ action: "onlyworlds-signin", code: "pc", state: auth.searchParams.get("state") as string });
	assert.equal(schemeReturnIsExpected(holder, url), true, "the parked state matches");
	assert.equal(schemeReturnIsExpected(holder, schemeReturnUrl({ action: "x", code: "pc", state: "forged" })), false, "a forged state is not let through");
	assert.equal(peekPending(holder)?.redirectUri, SCHEME_RETURN);
	assert.equal(receiveSchemeReturn(url), false, "nobody was waiting");
	assert.equal(await completeFromUrl(e, url), "ow_a_phone");
	assert.equal(log[0].body.redirect_uri, SCHEME_RETURN);
	assert.equal(holder.pendingSignIn, "");
});

test("an obsidian:// link is not let through when nothing is parked, when the parked sign-in used the loopback, or after the time limit", () => {
	const none: PendingHolder = { pendingSignIn: "" };
	assert.equal(schemeReturnIsExpected(none, "obsidian://onlyworlds-signin?code=c&state=s"), false, "nothing parked");
	let t = 0;
	const s = pendingStorage(none, () => undefined, () => t);
	s.set("onlyworlds-signin:obsidian", JSON.stringify({ state: "s", verifier: "v", redirectUri: "http://127.0.0.1:5000/onlyworlds-signin" }));
	assert.equal(schemeReturnIsExpected(none, "obsidian://onlyworlds-signin?code=c&state=s", () => t), false, "a loopback sign-in does not take an obsidian:// return");
	s.set("onlyworlds-signin:obsidian", JSON.stringify({ state: "s", verifier: "v", redirectUri: SCHEME_RETURN }));
	assert.equal(schemeReturnIsExpected(none, "obsidian://onlyworlds-signin?code=c&state=s", () => t), true);
	assert.equal(schemeReturnIsExpected(none, "obsidian://onlyworlds-signin?code=c&state=s", () => t + 10 * 60_000), false, "after the time limit");
	assert.equal(schemeReturnIsExpected(none, "not a url", () => t), false);
});

test("the scheme wait gives up after its time limit", async () => {
	const w = waitForSchemeReturn(30);
	await assert.rejects(w.url, /timeout/);
	assert.equal(receiveSchemeReturn("obsidian://onlyworlds-signin?code=1&state=2"), false, "and takes nothing afterwards");
});

test("mobile: a dialog waiting for the scheme return takes the address, once", async () => {
	const w = waitForSchemeReturn();
	assert.equal(receiveSchemeReturn("obsidian://onlyworlds-signin?code=1&state=2"), true);
	assert.equal(await w.url, "obsidian://onlyworlds-signin?code=1&state=2");
	assert.equal(receiveSchemeReturn("obsidian://onlyworlds-signin?code=3&state=4"), false, "a second return finds nobody waiting");
	const w2 = waitForSchemeReturn();
	w2.cancel();
	assert.equal(receiveSchemeReturn("obsidian://onlyworlds-signin?code=5&state=6"), false, "a cancelled wait takes nothing");
});

test("a listener that cannot bind falls back to the obsidian:// return", async () => {
	const holder: PendingHolder = { pendingSignIn: "" };
	const opened: string[] = [];
	const e = { ...env(holder, keelFetch([], { status: 200, json: {} }), opened), listen: () => Promise.reject(new Error("EADDRINUSE")) };
	const s = await beginBrowserSignIn(e);
	assert.equal(s.via, "scheme");
	assert.equal(new URL(opened[0]).searchParams.get("redirect_uri"), SCHEME_RETURN);
});
