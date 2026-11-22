/**
 * A world's category folder, `Elements/<Type>` — PURE, no
 * Obsidian imports.
 *
 * The Markdown profile of the folder format puts one note per element at
 * `<Type>/<Name>.md`, with no count in any address (Skeld, 2026-10-22): a
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

import { Category } from "../enums";

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

// ---------------------------------------------------------------------------
// A note anywhere in a world's folder (the Markdown profile, sentences 1 to 3)
// ---------------------------------------------------------------------------

/** The 22 types, by their folder spelling (`Character`). */
const TYPE_NAMES: ReadonlyMap<string, string> = new Map(
	Object.keys(Category).filter((k) => isNaN(Number(k))).map((k) => [k.toLowerCase(), k])
);

/** The type a name stands for (`character`, `Character`, `Location (2)`), as the folder spelling, or null when it is none of the 22. */
export function typeNamed(name: string): string | null {
	return TYPE_NAMES.get(categoryFolderType(name.trim()).toLowerCase()) ?? null;
}

/**
 * The world and the folders and file below its folder
 * (`OnlyWorlds/Worlds/<world>/<folders...>/<name>.md`), or null when the path
 * lies in no world's folder. A note in a folder whose name starts with `.` is
 * no element's: its `folders` carry the dot-folder, and a caller that reads
 * elements skips it (`inUnreadFolder`).
 */
export function worldNotePath(path: string): { worldName: string; folders: string[]; file: string } | null {
	const m = /^OnlyWorlds\/Worlds\/([^/]+)\/(.+\.md)$/i.exec(path);
	if (!m) return null;
	const parts = m[2].split("/");
	return { worldName: m[1], folders: parts.slice(0, -1), file: parts[parts.length - 1] };
}

/**
 * True when a note there is never read as an element: a folder on the path
 * starts with `.` (sentence 1), or the note is in the world's `records/`, the
 * producers' own tree, which no element scan has ever read.
 */
export function inUnreadFolder(folders: string[]): boolean {
	return folders[0] === "records" || folders.some((f) => f.startsWith("."));
}

/**
 * The type a note's place decides (sentence 2): the first folder on its path,
 * from the world's folder down, that is named for one of the 22. Null when no
 * folder is (the note is then read by its `type` property, or is not an element).
 */
export function typeOfPlace(path: string): { worldName: string; type: string } | null {
	const parts = worldNotePath(path);
	if (!parts || inUnreadFolder(parts.folders)) return null;
	for (const f of parts.folders) {
		const t = typeNamed(f);
		if (t) return { worldName: parts.worldName, type: t };
	}
	return null;
}

/**
 * The type of an element note outside every type folder: its `type` property,
 * which must name one of the 22 (sentence 2). Null when it does not.
 */
export function typeOfProperty(fmType: unknown): string | null {
	return typeof fmType === "string" ? typeNamed(fmType) : null;
}

/** A UUID in its usual lower-case form: the id an element note carries (sentence 1). */
export function isElementId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/**
 * True when a note may be an element note of `worldName` (any world when
 * omitted): it lies in the world's folder, in no dot-folder and not in
 * `records/`, and is not the world's own `World.md`. Whether it IS one is
 * read from the note (an id, and a type by place or property): this is the
 * scan's filter, the one place that says where element notes may sit.
 */
export function mayBeElementNote(path: string, worldName?: string): boolean {
	const parts = worldNotePath(path);
	if (!parts || inUnreadFolder(parts.folders)) return false;
	if (worldName !== undefined && parts.worldName !== worldName) return false;
	return !(parts.folders.length === 0 && parts.file.toLowerCase() === "world.md");
}
