/**
 * A writer (Download, Paste, Import) finds the note an element already has by
 * the id in the note, and writes to it. The metadata cache can still hold an id
 * a person has just taken out of the note; a writer that trusted it wrote the
 * element over what had become the person's own note. The pick is now
 * confirmed from the note's bytes.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { writeElement, readElement } from "../vault/element-file";

const A = "019e0000-0000-7000-8000-0000000000e1";
const FOLDER = "OnlyWorlds/Worlds/W/Elements/Character";
const MINE = "My notes on Bob, the only copy.\n\nMore of my writing.\n";

/** Run `fn` with the metadata cache answering `entry` for every note whose path ends in `end`. */
async function withCache<T>(end: string, entry: unknown, fn: () => Promise<T>): Promise<T> {
	const proto = (await import("./support/obsidian-mock")).MockMetadataCache.prototype as unknown as { getFileCache(f: { path: string }): unknown };
	const orig = proto.getFileCache;
	proto.getFileCache = function (this: unknown, f: { path: string }) {
		return f.path.endsWith(end) ? entry : orig.call(this, f);
	};
	try {
		return await fn();
	} finally {
		proto.getFileCache = orig;
	}
}

/** Every element note under the folder, id -> path. */
async function holders(app: ReturnType<typeof makeApp>["app"]): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const f of app.vault.getMarkdownFiles()) {
		const el = await readElement(app, f);
		if (el) out[el.id] = f.path;
	}
	return out;
}

test("★ a pull never writes over a note whose id was just taken out, though the cache still holds it", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${FOLDER}/Bob.md`, MINE);
	await withCache("Character/Bob.md", { frontmatter: { id: A, name: "Bob" } }, () =>
		writeElement(app, "W", "character", A, { name: "Bob", description: "From the server." })
	);
	assert.equal(vault.contentAt(`${FOLDER}/Bob.md`), MINE, "the person's note was written over");
	const h = await holders(app);
	assert.ok(h[A] && h[A] !== `${FOLDER}/Bob.md`, `the element has no note of its own: ${JSON.stringify(h)}`);
	assert.match(vault.contentAt(h[A]) ?? "", /From the server\./);
});

test("★ a stale note is passed over for the note that really holds the id", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${FOLDER}/Bob.md`, MINE);
	await vault.seed(`${FOLDER}/Bob2.md`, `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nOld.\n`);
	await withCache("Character/Bob.md", { frontmatter: { id: A, name: "Bob" } }, () =>
		writeElement(app, "W", "character", A, { name: "Bob", description: "From the server." })
	);
	assert.equal(vault.contentAt(`${FOLDER}/Bob.md`), MINE);
	const h = await holders(app);
	assert.equal(h[A], `${FOLDER}/Bob2.md`, JSON.stringify(h));
	assert.match(vault.contentAt(`${FOLDER}/Bob2.md`) ?? "", /From the server\./);
});

test("control: a note that holds the id is rewritten in place", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${FOLDER}/Bob.md`, `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nOld.\n`);
	await writeElement(app, "W", "character", A, { name: "Bob", description: "From the server." });
	const h = await holders(app);
	assert.deepEqual(Object.keys(h), [A]);
	assert.equal(h[A], `${FOLDER}/Bob.md`);
	assert.match(vault.contentAt(`${FOLDER}/Bob.md`) ?? "", /From the server\./);
});
