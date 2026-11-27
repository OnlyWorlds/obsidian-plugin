import { App, normalizePath } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import { ownFrontmatterId } from "./element-file";
import { asKeptCopy, capKeptName, fencedCopy, KEPT_FOLDER, keptCopyName } from "./note-mark-core";

/**
 * The copy before replace, the Obsidian-facing half (the pure half is note-mark-core.ts): a note a writer is about to replace
 * and cannot prove unchanged since the plugin last wrote or saved it is copied whole into the world's Kept edits/ first.
 */

/**
 * The note as it was, whole, in the world's Kept edits/ folder, under a name with the moment in it (`name` is the note's
 * name, never its file name); the copy's `id` key is `kept_from`, so it is a person's own note and no reader takes it for the
 * element. A copy that cannot be written throws, and the caller then does not replace the note: nothing is lost silently.
 */
export async function keepCopy(app: App, worldName: string, name: string, text: string, markSelfWrite?: (path: string) => void): Promise<void> {
	const folder = `OnlyWorlds/Worlds/${worldName}/${KEPT_FOLDER}`;
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) {
		// A second device or a sync may make the folder in the same moment: a folder that is there is all that is wanted.
		try { await app.vault.createFolder(folder); } catch (error) { if (!(await adapter.exists(folder))) throw error; }
	}
	const base = keptCopyName(capKeptName(sanitizeFileName(name)), new Date());
	let path = normalizePath(`${folder}/${base}.md`);
	for (let n = 2; await adapter.exists(path); n++) path = normalizePath(`${folder}/${base} ${n}.md`);
	markSelfWrite?.(path);
	// An `id` the key rename cannot read (flow style) would leave the copy an element note: the whole note then goes in a fence instead.
	let kept = asKeptCopy(text);
	if (ownFrontmatterId(kept) !== null) kept = fencedCopy(text);
	await app.vault.create(path, kept);
}
