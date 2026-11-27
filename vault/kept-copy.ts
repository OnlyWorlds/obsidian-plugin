import { App, normalizePath } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import { worldNotePath } from "./category-folder";
import { changeSeqIndexUnreadable, readChangeSeqIndex, type ChangeSeqIndex } from "./change-seq-index";
import { ownFrontmatterId } from "./element-file";
import { asKeptCopy, capKeptName, fencedCopy, holdsUnsavedEdits, KEPT_FOLDER, keptCopyName, markKey } from "./note-mark-core";

/**
 * The copy before replace, the Obsidian-facing half (the pure half is note-mark-core.ts): a note a writer is about to replace
 * and cannot prove unchanged since the plugin last wrote or saved it is copied whole into the world's Kept edits/ first.
 */

/** True when the note lies in a world's Kept edits/ folder: a copy, a person's own note, never an element's. */
export function inKeptFolder(path: string): boolean {
	return worldNotePath(path)?.folders[0] === KEPT_FOLDER;
}

/** A copy that could not be written: the note it was for is not replaced, and the run that met it stops there. */
export class KeptCopyFailed extends Error {
	constructor(readonly label: string, readonly reason: string) {
		super(`could not keep a copy of ${label}: ${reason}`);
	}
}

/**
 * One run's copies before replace (a pull, a paste): the world's marks, read once, and the labels of the notes it copied whose
 * write then went through, for the run's one notice.
 */
export class KeptCopies {
	/** The labels of the notes copied and then written, in the order their writes landed. */
	readonly copied: string[] = [];

	private constructor(
		private readonly app: App,
		private readonly worldName: string,
		/** The world's index as the run found it. */
		readonly marks: ChangeSeqIndex,
		/** An index that is there and cannot be read is no claim that nothing was typed: every note replaced is copied. */
		readonly unreadable: boolean,
		private readonly markSelfWrite?: (path: string) => void
	) {}

	static async open(app: App, worldName: string, markSelfWrite?: (path: string) => void): Promise<KeptCopies> {
		return new KeptCopies(app, worldName, await readChangeSeqIndex(app, worldName), await changeSeqIndexUnreadable(app, worldName), markSelfWrite);
	}

	/**
	 * One note's write: `beforeReplace` for the writer (it copies the bytes it is handed unless they hash to the id's mark, and
	 * throws KeptCopyFailed when the copy cannot be written), and `landed`, called once the write went through, which names the
	 * note in the run's notice if it was copied. `name` names the copy's file, `label` the note in a notice.
	 */
	forNote(id: string, name: string, label: string): { beforeReplace: (text: string) => Promise<void>; landed: () => void } {
		let made = false;
		return {
			beforeReplace: async (text) => {
				if (!this.unreadable && !holdsUnsavedEdits(text, this.marks[markKey(id)])) return;
				try {
					await keepCopy(this.app, this.worldName, name, text, this.markSelfWrite);
				} catch (error) {
					throw new KeptCopyFailed(label, error instanceof Error ? error.message : String(error));
				}
				made = true;
			},
			landed: () => {
				if (made) this.copied.push(label);
			},
		};
	}
}

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
