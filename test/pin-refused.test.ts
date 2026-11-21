/**
 * A wrong PIN (server rule of 2026-11-21) is a 401 naming `API-Pin` each
 * time, and the same wrong PIN sent again never locks anything. The plugin used
 * to keep a refused PIN (the saved setting and the session copy alike) and send
 * it with every later save, so ten different stale PINs, or forty auto-sync
 * saves at once, were counted against the person's key and account. Now a PIN
 * keel refuses is forgotten, the next save asks the person once, and auto-sync
 * runs a few saves at a time.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __modals } from "./support/obsidian-mock";
import { V2Client, V2ApiError } from "../client-v2";
import { PinCache } from "../auth/pin-cache";
import { AutoSyncEngine } from "../sync/auto-sync";
import { SaveElementCommand } from "../Commands/SaveElementCommand";

const envelope = (status: number, code: string, param?: string) => ({
	status,
	json: { error: { type: "authentication_error", code, message: "keel's sentence", ...(param ? { param } : {}) } },
});

async function answered(status: number, code: string, param?: string): Promise<{ refused: number; error: V2ApiError }> {
	setRequestUrl(() => envelope(status, code, param));
	let refused = 0;
	const client = new V2Client("ow_w_test", "1234", { onPinRefused: () => refused++ });
	try {
		await client.getWorld();
	} catch (e) {
		return { refused, error: e as V2ApiError };
	}
	throw new Error("the request did not fail");
}

test("★ a 401 naming API-Pin tells the cache once and the error carries the param", async () => {
	const r = await answered(401, "invalid_pin", "API-Pin");
	assert.equal(r.refused, 1);
	assert.equal(r.error.param, "API-Pin");
	assert.equal(r.error.status, 401);
});

test("only that answer is a refused PIN: a 401 naming no field, a 429 on the PIN, a 403 and a 404 are not", async () => {
	assert.equal((await answered(401, "invalid_key")).refused, 0, "a 401 with no param is the key's");
	assert.equal((await answered(401, "invalid_key", "API-Key")).refused, 0);
	assert.equal((await answered(429, "rate_limited", "API-Pin")).refused, 0, "a wait is not a wrong PIN");
	assert.equal((await answered(403, "keeper_only")).refused, 0);
	assert.equal((await answered(404, "not_found")).refused, 0);
});

test("a client built with no callback still fails with the same error", async () => {
	setRequestUrl(() => envelope(401, "invalid_pin", "API-Pin"));
	await assert.rejects(new V2Client("ow_w_test", "1234").getWorld(), (e: unknown) => e instanceof V2ApiError && e.param === "API-Pin");
});

test("★ a refused SAVED PIN is not handed out again: the next ask opens the prompt, until the setting changes", async () => {
	const { app } = makeApp();
	let saved = "1111";
	const cache = new PinCache(app as App, () => saved);
	assert.equal(await cache.get(), "1111");
	cache.refuse("1111");
	__modals.length = 0;
	const asked = cache.get();
	assert.equal(__modals.length, 1, "the refused saved PIN was returned instead of asking");
	assert.equal(cache.peek(), null, "peek still offers the refused PIN");
	(__modals.pop() as unknown as { onClose(): void }).onClose();
	assert.equal(await asked, null);
	saved = "2222"; // the person fixed the setting: that is a new PIN and is tried
	assert.equal(await cache.get(), "2222");
	assert.equal(cache.peek(), "2222");
});

test("★ a refused SESSION PIN is dropped, and several saves asking at once see one prompt", async () => {
	const { app } = makeApp();
	const cache = new PinCache(app as App);
	__modals.length = 0;
	const first = cache.get();
	(__modals.pop() as unknown as { onClose(): void }).onClose();
	assert.equal(await first, null);

	// two asks while the prompt is open: one modal
	__modals.length = 0;
	const a = cache.get();
	const b = cache.get();
	assert.equal(__modals.length, 1, "two saves opened two prompts");
	(__modals.pop() as unknown as { onClose(): void }).onClose();
	assert.equal(await a, null);
	assert.equal(await b, null);
	// and the next ask, once it closed, opens a fresh prompt
	__modals.length = 0;
	const c = cache.get();
	assert.equal(__modals.length, 1);
	(__modals.pop() as unknown as { onClose(): void }).onClose();
	await c;

	// a session PIN that keel refuses is cleared
	const withPin = new PinCache(app as App);
	(withPin as unknown as { pin: string }).pin = "4444";
	assert.equal(await withPin.get(), "4444");
	withPin.refuse("4444");
	assert.equal(withPin.peek(), null);
	// a different PIN is not the refused one
	(withPin as unknown as { pin: string }).pin = "5555";
	withPin.refuse("4444");
	assert.equal(withPin.peek(), "5555");
});

test("★ auto-sync runs at most MAX_PARALLEL_SAVES saves at once and finishes all of them", async () => {
	const { app } = makeApp();
	const engine = new AutoSyncEngine(app as App, {} as never);
	let running = 0;
	let peak = 0;
	let done = 0;
	(engine as unknown as { syncFileNow: (f: TFile) => Promise<void> }).syncFileNow = async () => {
		running++;
		peak = Math.max(peak, running);
		await new Promise((r) => setTimeout(r, 5));
		running--;
		done++;
	};
	const files = Array.from({ length: 12 }, (_, i) => ({ path: `n${i}.md` }) as unknown as TFile);
	await Promise.all(files.map((f) => (engine as unknown as { syncFile: (f: TFile) => Promise<void> }).syncFile(f)));
	assert.equal(done, 12);
	assert.equal(peak, AutoSyncEngine.MAX_PARALLEL_SAVES);
	assert.equal((engine as unknown as { activeSaves: number }).activeSaves, 0, "a place was never given back");
});

test("a save that throws gives its place to the next in line", async () => {
	const { app } = makeApp();
	const engine = new AutoSyncEngine(app as App, {} as never);
	let n = 0;
	(engine as unknown as { syncFileNow: (f: TFile) => Promise<void> }).syncFileNow = async () => {
		n++;
		if (n <= AutoSyncEngine.MAX_PARALLEL_SAVES) throw new Error("a refused save");
	};
	const files = Array.from({ length: 8 }, (_, i) => ({ path: `n${i}.md` }) as unknown as TFile);
	const results = await Promise.allSettled(files.map((f) => (engine as unknown as { syncFile: (f: TFile) => Promise<void> }).syncFile(f)));
	assert.equal(n, 8, "a place stayed taken after a throw");
	assert.equal(results.filter((r) => r.status === "rejected").length, AutoSyncEngine.MAX_PARALLEL_SAVES);
});

test("★ two refusals in a row: the saved PIN stays out after a typed PIN is refused too", async () => {
	const { app } = makeApp();
	const cache = new PinCache(app as App, () => "1111");
	cache.refuse("1111"); // the saved PIN, refused
	(cache as unknown as { pin: string }).pin = "9999"; // the person typed another
	assert.equal(await cache.get(), "9999");
	cache.refuse("9999"); // refused as well
	assert.equal(cache.peek(), null, "the saved PIN came back after a second refusal");
	__modals.length = 0;
	const asked = cache.get();
	assert.equal(__modals.length, 1, "the saved PIN was sent instead of asking");
	(__modals.pop() as unknown as { onClose(): void }).onClose();
	assert.equal(await asked, null);
});

test("★ a Cancel on the PIN prompt ends the burst: saves still waiting for a place do not ask again", async () => {
	const { app } = makeApp();
	const engine = new AutoSyncEngine(app as App, { setSyncStatus() {}, settings: {} } as never);
	const proto = SaveElementCommand.prototype as unknown as { execute: (f: TFile) => Promise<unknown> };
	const saved = proto.execute;
	let asked = 0;
	proto.execute = async () => {
		asked++;
		await new Promise((r) => setTimeout(r, 5));
		return { ok: false, reason: "Save cancelled: PIN not provided.", pinCancelled: true };
	};
	try {
		const files = Array.from({ length: 10 }, (_, i) => ({ path: `n${i}.md` }) as unknown as TFile);
		await Promise.all(files.map((f) => (engine as unknown as { syncFile: (f: TFile) => Promise<void> }).syncFile(f)));
	} finally {
		proto.execute = saved;
	}
	assert.equal(asked, AutoSyncEngine.MAX_PARALLEL_SAVES, "the queued saves each asked again");
	assert.equal((engine as unknown as { activeSaves: number }).activeSaves, 0, "a place stayed taken");
	assert.equal((engine as unknown as { waitingSaves: unknown[] }).waitingSaves.length, 0);
});

test("a save that fails for another reason does not drop the queue", async () => {
	const { app } = makeApp();
	const engine = new AutoSyncEngine(app as App, { setSyncStatus() {}, settings: {} } as never);
	const proto = SaveElementCommand.prototype as unknown as { execute: (f: TFile) => Promise<unknown> };
	const saved = proto.execute;
	let ran = 0;
	proto.execute = async () => {
		ran++;
		await new Promise((r) => setTimeout(r, 2));
		return { ok: false, reason: "a 422" };
	};
	try {
		const files = Array.from({ length: 8 }, (_, i) => ({ path: `n${i}.md` }) as unknown as TFile);
		await Promise.all(files.map((f) => (engine as unknown as { syncFile: (f: TFile) => Promise<void> }).syncFile(f)));
	} finally {
		proto.execute = saved;
	}
	assert.equal(ran, 8);
});
