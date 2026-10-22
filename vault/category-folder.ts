/**
 * A world's category folder, `Elements/<Type>` (OW Obsidian #560) — PURE, no
 * Obsidian imports.
 *
 * The Markdown profile of the folder format puts one note per element at
 * `<Type>/<Name>.md`, with no count in any address (Skeld, h69 #10512): a
 * count lives in a view, never in a name that Sync, git and a link carry.
 * Up to 3.8.1 the plugin wrote `<Type> (<count>)` (`Location (2)`) and renamed
 * the folder at every new note. Download renames such a folder once
 * (vault/plain-folders.ts); until then every reader still finds it.
 *
 * ★ This file is the one place in the code that knows the old spelling.
 * Everything that finds, matches or names a category folder asks here. The one
 * other place is the Bases file's folder filter (vault/bases-file.ts), a text
 * Obsidian evaluates: it matches `<Type> (` too, kept so a folder the rename
 * pass had to leave stays visible in the views.
 */

/** The count an older plugin put after a type folder's name: `Location (2)`. */
const LEGACY_COUNT = /\s*\(\d+\)$/;

/** The type a category folder holds: `Location (2)` and `Location` are both Location. */
export function categoryFolderType(folderName: string): string {
	return folderName.replace(LEGACY_COUNT, "");
}

/** True when `folderName` is the old counted spelling of a type folder (`Location (2)`). */
export function isCountedCategoryFolder(folderName: string): boolean {
	return LEGACY_COUNT.test(folderName) && categoryFolderType(folderName) !== "";
}

/** True when `folderName` is `type`'s folder in either spelling (`Location`, or `Location (2)` from 3.8.1 or earlier). */
export function isCategoryFolderOf(folderName: string, type: string): boolean {
	return folderName === type || (isCountedCategoryFolder(folderName) && categoryFolderType(folderName) === type);
}

/**
 * The world and type folder of an element note's vault path
 * (`OnlyWorlds/Worlds/<world>/Elements/<folder>/<...>.md`), or null when the
 * path is not one. `folder` is the folder's name as it is on disk, `type` the
 * type it holds.
 */
export function elementPathParts(path: string): { worldName: string; folder: string; type: string } | null {
	const m = /^OnlyWorlds\/Worlds\/([^/]+)\/Elements\/([^/]+)\/.+\.md$/i.exec(path);
	if (!m) return null;
	return { worldName: m[1], folder: m[2], type: categoryFolderType(m[2]) };
}

/**
 * True when `path` lies inside `type`'s folder, in either spelling, under a
 * world's `elementsPath` (`OnlyWorlds/Worlds/<world>/Elements`), at any depth.
 */
export function isInCategoryFolder(path: string, elementsPath: string, type: string): boolean {
	const root = elementsPath.replace(/\/+$/, "") + "/";
	if (!path.startsWith(root)) return false;
	const rest = path.slice(root.length);
	const slash = rest.indexOf("/");
	return slash > 0 && isCategoryFolderOf(rest.slice(0, slash), type);
}
