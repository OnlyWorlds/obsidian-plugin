import { App, TAbstractFile, TFolder, normalizePath } from "obsidian";
import { Category } from "../enums";
import { categoryFolderType, isCountedCategoryFolder } from "./category-folder";

/**
 * The one-time rename of a world's counted type folders (OW Obsidian #560).
 *
 * Up to 3.8.1 the plugin named a type folder with its note count, `Location (2)`,
 * and renamed it at every new note; the Markdown profile's address is
 * `<Type>/<Name>.md`, no count (Skeld, h69 #10512). Download calls this before
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
}

const TYPES = new Set(Object.keys(Category).filter((k) => isNaN(Number(k))));

/** Something the vault or the disk holds at `path` (any case, on a disk that ignores case). */
async function occupied(app: App, path: string): Promise<boolean> {
	return app.vault.getAbstractFileByPath(path) !== null || (await app.vault.adapter.exists(path));
}

/** Rename the counted type folders of `OnlyWorlds/Worlds/<worldFolder>/Elements` to `<Type>`. */
export async function renameCountedCategoryFolders(app: App, worldFolder: string): Promise<PlainFoldersResult> {
	const result: PlainFoldersResult = { renamed: [], stuck: [] };
	const elements = app.vault.getAbstractFileByPath(normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements`));
	if (!(elements instanceof TFolder)) return result;

	const counted = elements.children
		.filter((c): c is TFolder => c instanceof TFolder && isCountedCategoryFolder(c.name) && TYPES.has(categoryFolderType(c.name)))
		.sort((a, b) => a.name.localeCompare(b.name));

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
		try {
			const onDisk = await app.vault.adapter.list(folder.path);
			if (onDisk.files.length === 0 && onDisk.folders.length === 0) await app.fileManager.trashFile(folder);
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
		const first = result.renamed[0];
		lines.push(
			`${n} type folder${n === 1 ? "" : "s"} renamed without the count (${first} is now ${categoryFolderType(first)}). ` +
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
	return lines.length > 0 ? lines.join("\n") : null;
}
