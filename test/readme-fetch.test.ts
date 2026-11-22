/**
 * The Readme note.
 *
 * Create world, Download world and Paste world each ran a GET to raw.githubusercontent.com and wrote the
 * answer over `OnlyWorlds/README.md`: an edited README was replaced, and a local-only world made a request
 * its README's privacy section says no local world makes. Now the fetch runs only when the note is missing,
 * and never for a local-only world.
 *
 * The three commands call CreateCoreFilesCommand, so it is the one place tried here, through an in-memory vault
 * (test/support/obsidian-mock.ts). Which worlds count as local is decided at each caller by the key the world
 * holds; that wiring is walked in the real app, not here.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import { CreateCoreFilesCommand } from "../Commands/CreateCoreFilesCommand";
import { classifyWorldKey } from "../vault/world-key-core";

const README = "OnlyWorlds/README.md";
const manifest = { id: "onlyworlds-builder", version: "0.0.0" };

/** A vault whose `OnlyWorlds` folder exists, as it does by the time any of the three commands writes core files (the world's folder is made first). */
async function vaultWithRoot() {
	const made = makeApp();
	await made.app.vault.createFolder("OnlyWorlds");
	return made;
}

/** Run `body` with global fetch replaced by a counter that answers `text`; restores fetch after. */
async function withFetch(text: string, status: number, body: (calls: string[]) => Promise<void>): Promise<void> {
	const real = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "Not Found", text: async () => text } as Response;
	}) as typeof fetch;
	try {
		await body(calls);
	} finally {
		globalThis.fetch = real;
	}
}

test("a missing README is fetched once and written", async () => {
	const { app, vault } = await vaultWithRoot();
	await withFetch("# the repo's README\n", 200, async (calls) => {
		await new CreateCoreFilesCommand(app, manifest).execute();
		assert.equal(calls.length, 1);
		assert.match(calls[0], /raw\.githubusercontent\.com\/OnlyWorlds\/obsidian-plugin\/main\/README\.md$/);
		assert.equal(vault.contentAt(README), "# the repo's README\n");
	});
});

test("★ an edited README survives: no request, the note is the person's bytes", async () => {
	const { app, vault } = await vaultWithRoot();
	await app.vault.create(README, "my own notes about my worlds\n");
	await withFetch("# the repo's README\n", 200, async (calls) => {
		await new CreateCoreFilesCommand(app, manifest).execute();
		assert.equal(calls.length, 0, "a request went out although the README was there");
		assert.equal(vault.contentAt(README), "my own notes about my worlds\n");
	});
});

test("★ a local-only world makes no request and gets no README", async () => {
	const { app, vault } = await vaultWithRoot();
	await withFetch("# the repo's README\n", 200, async (calls) => {
		await new CreateCoreFilesCommand(app, manifest, { localOnly: true }).execute();
		assert.equal(calls.length, 0, "a local-only world made a request");
		assert.equal(vault.contentAt(README), undefined);
	});
});

test("a local-only world keeps an existing README as it is, too", async () => {
	const { app, vault } = await vaultWithRoot();
	await app.vault.create(README, "kept\n");
	await withFetch("# the repo's README\n", 200, async (calls) => {
		await new CreateCoreFilesCommand(app, manifest, { localOnly: true }).execute();
		assert.equal(calls.length, 0);
		assert.equal(vault.contentAt(README), "kept\n");
	});
});

test("a README that cannot be fetched says so and writes nothing", async () => {
	const { app, vault } = await vaultWithRoot();
	__notices.length = 0;
	await withFetch("", 404, async (calls) => {
		await new CreateCoreFilesCommand(app, manifest).execute();
		assert.equal(calls.length, 1);
		assert.equal(vault.contentAt(README), undefined);
		assert.ok(__notices.some((n) => n.includes("Could not fetch the README")), "no notice: " + JSON.stringify(__notices));
	});
});

test("Paste world decides local-only by the plugin's own key rule: Local, LOCAL and a padded key count, a real key does not", () => {
	for (const k of ["local", "Local", "LOCAL", "  local  "]) assert.equal(classifyWorldKey(k, undefined).source, "local-world", k);
	for (const k of ["ow_w_abc", "1234567890", "ow_r_abc"]) assert.notEqual(classifyWorldKey(k, undefined).source, "local-world", k);
});
