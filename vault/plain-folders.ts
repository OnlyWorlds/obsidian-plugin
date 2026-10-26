import { App, TAbstractFile, TFolder, normalizePath } from "obsidian";
import { Category } from "../enums";
import { categoryFolderType, isCountedCategoryFolder } from "./category-folder";

/**
 * The one-time rename of a world's counted type folders.
 *
 * Up to 3.8.1 the plugin named a type folder with its note count, `Location (2)`,
 * and renamed it at every new note; the Markdown profile's address is
 * `<Type>/<Name>.md`, no count (Skeld, 2026-10-22). Download calls this before
 * it writes a note, so the notes land in the plain folders:
 *   - a counted folder alone is renamed to its plain name;
 *   - beside a plain folder of the same type, its notes (and anything else in
 *     it) move into the plain one, one by one, and the counted folder is
 *     removed only when the disk shows it empty: a folder, never a note;
 *   - when any name in it is taken in the plain folder, nothing of that folder
 *     moves: it is reported by folder and note for the person to sort out.
 * Every move goes through `fileManager.renameFile`: links by note name still
 * resolve, and links written with a folder path follow the person's Obsidian
 * setting for updating links. Never a delete of a note, never an overwrite, never a new
 * file name: a note keeps its name and its bytes.
 */

/** A counted folder whose notes could not move into the plain one. */
export interface StuckFolder {
	/** The counted folder, `Location (2)`. */
	folder: string;
	/** Its plain folder, `Location`. */
	plain: string;
	/** The first name in it that the plain folder already holds (a note, a file, a folder); "" when something by the plain folder's own name is in the way. */
	note: string;
	/** How many more names clash besides `note`. */
	more: number;
	/** `clash`: a name was taken, nothing moved. `error`: Obsidian refused a move part way (`note` is the one refused). */
	why: "clash" | "error";
	/** How many of the folder's notes and files moved before the stop. */
	moved: number;
	/** How many the folder held when the move began. */
	total: number;
}

export interface PlainFoldersResult {
	/** The counted folders now gone into their plain names (renamed, or merged into one). */
	renamed: string[];
	stuck: StuckFolder[];
	/** Counted folders whose notes all moved, kept because the disk still shows something in them (`file`, the first such name: a hidden file Obsidian does not list; "" when the disk listing could not be read). */
	kept: { folder: string; file: string }[];
}

/** The Notice shown before the pass renames anything (amendment B: Obsidian's Update links prompt otherwise holds the download with nothing said). */
export const RENAME_START_NOTICE =
	"Renaming your type folders to drop the count. Obsidian may ask whether to update links; Always update answers it for the rest and turns on Obsidian's automatic link updating for this vault.";

/** The disk's own listing of a folder (hidden files included), or null when it cannot be read. */
async function diskListing(app: App, path: string): Promise<string[] | null> {
	try {
		const listed = await app.vault.adapter.list(path);
		return [...listed.files, ...listed.folders];
	} catch {
		return null;
	}
}

const TYPES = new Set(Object.keys(Category).filter((k) => isNaN(Number(k))));

/** Something the vault or the disk holds at `path` (any case, on a disk that ignores case). */
async function occupied(app: App, path: string): Promise<boolean> {
	return app.vault.getAbstractFileByPath(path) !== null || (await app.vault.adapter.exists(path));
}

/**
 * Rename the counted type folders of `OnlyWorlds/Worlds/<worldFolder>/Elements`
 * to `<Type>`. `onStart` is called once, before the first rename, and only
 * when there is a folder to work on.
 */
export async function renameCountedCategoryFolders(
	app: App,
	worldFolder: string,
	opts: { onStart?: () => void } = {}
): Promise<PlainFoldersResult> {
	const result: PlainFoldersResult = { renamed: [], stuck: [], kept: [] };
	const elements = app.vault.getAbstractFileByPath(normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements`));
	if (!(elements instanceof TFolder)) return result;

	const counted: TFolder[] = [];
	for (const c of elements.children) {
		if (!(c instanceof TFolder) || !isCountedCategoryFolder(c.name) || !TYPES.has(categoryFolderType(c.name))) continue;
		// A folder an earlier pass kept beside its plain folder: the vault lists
		// nothing in it and the disk does (a hidden file, nothing of the
		// plugin's). Skipped in silence: not renamed, not stuck, not kept again.
		const plain = app.vault.getAbstractFileByPath(normalizePath(`${elements.path}/${categoryFolderType(c.name)}`));
		if (plain instanceof TFolder && c.children.length === 0) {
			const onDisk = await diskListing(app, c.path);
			if (onDisk === null || onDisk.length > 0) continue;
		}
		counted.push(c);
	}
	counted.sort((a, b) => a.name.localeCompare(b.name));
	if (counted.length > 0) opts.onStart?.();

	for (const folder of counted) {
		const name = folder.name;
		const type = categoryFolderType(name);
		const plainPath = normalizePath(`${elements.path}/${type}`);
		const plain = app.vault.getAbstractFileByPath(plainPath);

		if (!plain) {
			// A name the disk holds under another case (Windows, macOS), or a
			// file the vault does not list: in the way, never replaced.
			if (await app.vault.adapter.exists(plainPath)) {
				result.stuck.push({ folder: name, plain: type, note: "", more: 0, why: "clash", moved: 0, total: 0 });
				continue;
			}
			try {
				await app.fileManager.renameFile(folder, plainPath);
				result.renamed.push(name);
			} catch (error) {
				console.error(`OnlyWorlds: could not rename the folder ${name} to ${type}`, error);
				result.stuck.push({ folder: name, plain: type, note: "", more: 0, why: "clash", moved: 0, total: 0 });
			}
			continue;
		}
		if (!(plain instanceof TFolder)) {
			// A file named like the type folder: nothing moves into a file.
			result.stuck.push({ folder: name, plain: type, note: "", more: 0, why: "clash", moved: 0, total: 0 });
			continue;
		}

		// Both spellings: every name is checked before anything moves, so a
		// folder moves whole or not at all.
		const takenHere = new Set(plain.children.map((c) => c.name.toLowerCase()));
		const clashes: TAbstractFile[] = [];
		for (const child of folder.children) {
			const target = normalizePath(`${plain.path}/${child.name}`);
			if (takenHere.has(child.name.toLowerCase()) || (await occupied(app, target))) clashes.push(child);
		}
		if (clashes.length > 0) {
			result.stuck.push({ folder: name, plain: type, note: clashes[0].name, more: clashes.length - 1, why: "clash", moved: 0, total: folder.children.length });
			continue;
		}

		const children = [...folder.children];
		let moved = 0;
		let refused = false;
		for (const child of children) {
			const childName = child.name;
			const target = normalizePath(`${plain.path}/${childName}`);
			try {
				// Checked again right before the move: never onto something.
				if (await occupied(app, target)) throw new Error(`${target} is taken`);
				await app.fileManager.renameFile(child, target);
				moved++;
			} catch (error) {
				console.error(`OnlyWorlds: could not move ${name}/${childName} into ${type}`, error);
				result.stuck.push({ folder: name, plain: type, note: childName, more: 0, why: "error", moved, total: children.length });
				refused = true;
				break;
			}
		}
		if (refused) continue;
		// The counted folder, emptied: removed only when the disk shows it empty
		// (its files and folders lists both empty, hidden files included, which
		// the vault does not list), to the trash the person chose. Anything left
		// on disk keeps it where it is: every reader and the Bases file see both
		// spellings.
		const onDisk = await diskListing(app, folder.path);
		if (onDisk === null || onDisk.length > 0) {
			const first = onDisk?.[0];
			result.kept.push({ folder: name, file: first ? (first.split("/").pop() ?? first) : "" });
			continue;
		}
		try {
			await app.fileManager.trashFile(folder);
		} catch (error) {
			console.info(`OnlyWorlds: left the emptied folder ${name} in place`, error);
		}
		result.renamed.push(name);
	}
	return result;
}

/** The one Notice the pass shows, or null when it changed and found nothing. */
export function plainFoldersNotice(result: PlainFoldersResult): string | null {
	const lines: string[] = [];
	const n = result.renamed.length;
	if (n > 0) {
		const shown = n <= 4 ? result.renamed : result.renamed.slice(0, 3);
		const from = andList(shown, n - shown.length);
		const to = andList(shown.map(categoryFolderType), n - shown.length);
		lines.push(
			`${n} type folder${n === 1 ? "" : "s"} renamed without the count: ${from} ${n === 1 ? "is" : "are"} now ${to}. ` +
				`Links by note name still work; links written with a folder path follow your Obsidian setting for updating links.`
		);
	}
	for (const s of result.stuck) {
		if (s.why === "error") {
			lines.push(
				`${s.moved} of ${s.total} notes moved from ${s.folder} into ${s.plain}, then Obsidian refused ${s.note}. ` +
					`Nothing was deleted; download again after moving the rest by hand.`
			);
			continue;
		}
		const others = s.more > 0 ? ` and ${s.more} more` : "";
		const why = s.note ? `${s.plain} already holds ${s.note}${others}` : `something named ${s.plain} is in the way`;
		lines.push(
			`Not moved: ${s.folder}, because ${why}. ` +
				`Nothing was deleted; rename or move one of them by hand, then download again.`
		);
	}
	for (const k of result.kept) {
		const why = k.file ? `it holds ${k.file}, which Obsidian does not show` : "its contents could not be read";
		lines.push(`${k.folder}'s notes moved into ${categoryFolderType(k.folder)}; the folder stays because ${why}.`);
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** `A`, `A and B`, `A, B and C`, or `A, B, C and 2 more`. */
function andList(names: string[], more: number): string {
	const items = more > 0 ? [...names, `${more} more`] : names;
	return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
