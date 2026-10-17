import { App, Notice, TFile, normalizePath } from "obsidian";
import { Category } from "../enums";
import { getCategorySchema } from "./element-transform";
import { buildBasesFile, hasBasesMarker, mayOverwriteBasesFile, stripBasesMarker, type BasesSchema } from "./bases-file";
import type { OnlyWorldsPluginSettings } from "../settings/settings";

/**
 * Writing a world's Bases file into the vault (OW Infra #188). The text is
 * vault/bases-file.ts's; this is the Obsidian-facing half: where the file
 * goes, and the rule that the plugin overwrites only a file it wrote and
 * nobody changed since.
 */

/** `absent`: no base found, and the caller asked for none to be created (Rename World). */
export type BasesWriteResult = "created" | "rewritten" | "unchanged" | "kept" | "absent";

export interface BasesWriteOutcome {
	result: BasesWriteResult;
	/** Where the world's base is, or was written. */
	path: string;
	/** The world's own name (World.md's Name line), for a Notice. */
	worldName: string;
	/** Write Bases file only: where the user's own version went when the command rebuilt it. */
	copy?: string;
}

/** The plugin's settings and their save: what remembers which Notices were shown. */
export interface BasesMemory {
	settings: Pick<OnlyWorldsPluginSettings, "basesKeptNoticed" | "basesIntroShown">;
	saveSettings(): Promise<void>;
}

/**
 * The Notice Download shows the first time it keeps a world's base because the
 * user changed it; Rename World shows it naming the rename.
 */
export function basesKeptNotice(worldName: string, renamed = false): string {
	const kept = renamed
		? "so it was left as is when you renamed the world, and its views still look in the old folder"
		: "so it was left as is";
	return `Your Bases file for ${worldName} has your own changes, ${kept}; delete it or run Write Bases file to rebuild it.`;
}

/** The Notice the first base Download writes into a world folder that had none shows, once per vault. */
export function basesIntroNotice(worldName: string): string {
	return `New: a Bases file for ${worldName} (tables and cards per type). Turn it off in Settings.`;
}

/** The 22 categories in the plugin's folder order, each with its schema fields. */
export function pluginBasesSchema(): BasesSchema {
	const out: BasesSchema = {};
	for (const key of Object.keys(Category)) {
		if (!isNaN(Number(key))) continue; // the enum's numeric reverse keys
		const fields = getCategorySchema(key);
		if (fields) out[key] = fields;
	}
	return out;
}

/** `OnlyWorlds/Worlds/<folder>/<folder>.base`, beside World.md. */
export function basesFilePath(worldFolder: string): string {
	return normalizePath(`OnlyWorlds/Worlds/${worldFolder}/${worldFolder}.base`);
}

/** World.md's Name line, or the folder name when it has none. */
async function worldNameOf(app: App, worldFolder: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(normalizePath(`OnlyWorlds/Worlds/${worldFolder}/World.md`));
	if (file instanceof TFile) {
		const m = /^- \*\*Name:\*\* (.+)$/m.exec(await app.vault.read(file));
		if (m && m[1].trim()) return m[1].trim();
	}
	return worldFolder;
}

function worldBasesText(worldName: string, worldFolder: string): string {
	return buildBasesFile({
		worldName,
		worldFolderPath: normalizePath(`OnlyWorlds/Worlds/${worldFolder}`),
		schema: pluginBasesSchema(),
	});
}

/** A free `<folder> (your copy).base` beside World.md, numbered when taken. */
async function freeCopyPath(app: App, worldFolder: string): Promise<string> {
	for (let n = 1; ; n++) {
		const name = n === 1 ? `${worldFolder} (your copy).base` : `${worldFolder} (your copy ${n}).base`;
		const p = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/${name}`);
		if (!app.vault.getAbstractFileByPath(p) && !(await app.vault.adapter.exists(p))) return p;
	}
}

interface FoundBase {
	/** The world's base, wherever it sits under the world folder; null when there is none. */
	file: TFile | null;
	/** A folder sits at the base's path. */
	blocked: boolean;
}

/**
 * The world's base: the file at `<folder>/<folder>.base`; else a `.base` under
 * the world folder named `alsoNamed` (Rename World: the old name), else the
 * first, by path, that carries the plugin's marker (a folder renamed by hand,
 * the file renamed). So there is never a second base beside the plugin's own.
 */
async function findWorldBase(app: App, worldFolder: string, alsoNamed?: string): Promise<FoundBase> {
	const at = app.vault.getAbstractFileByPath(basesFilePath(worldFolder));
	if (at instanceof TFile) return { file: at, blocked: false };
	if (at) return { file: null, blocked: true };
	const root = normalizePath(`OnlyWorlds/Worlds/${worldFolder}`) + "/";
	const under = app.vault
		.getFiles()
		.filter((f) => f.extension === "base" && f.path.startsWith(root))
		.sort((a, b) => a.path.localeCompare(b.path));
	const named = alsoNamed ? under.find((f) => f.path === normalizePath(root + alsoNamed)) : undefined;
	if (named) return { file: named, blocked: false };
	for (const f of under) {
		if (hasBasesMarker(await app.vault.read(f))) return { file: f, blocked: false };
	}
	return { file: null, blocked: false };
}

/** Give a base found elsewhere the world's own name, when that name is free. Returns where it is. */
async function placeAt(app: App, file: TFile, path: string): Promise<string> {
	if (file.path === path || app.vault.getAbstractFileByPath(path)) return file.path;
	await app.fileManager.renameFile(file, path);
	return path;
}

function sameText(current: string, text: string): boolean {
	return current.replace(/\r\n?/g, "\n") === text;
}

/**
 * Write (or refresh) the base of the world in `OnlyWorlds/Worlds/<folder>`,
 * `<folder>.base` beside World.md (see findWorldBase for one found elsewhere):
 * - no base: created (or "absent", with `create: false`);
 * - the plugin's own file, unchanged since: rewritten, and given the world's
 *   name when it sat elsewhere (or "unchanged" when the text is the same);
 * - anything else (a user's own base at the path, the plugin's file edited,
 *   a folder at the path): kept, untouched.
 */
export async function writeWorldBasesFileOutcome(
	app: App,
	worldFolder: string,
	opts: { create?: boolean; alsoNamed?: string } = {}
): Promise<BasesWriteOutcome> {
	const worldName = await worldNameOf(app, worldFolder);
	const text = worldBasesText(worldName, worldFolder);
	const path = basesFilePath(worldFolder);
	const found = await findWorldBase(app, worldFolder, opts.alsoNamed);
	if (found.blocked) return { result: "kept", path, worldName };
	const file = found.file;
	if (file) {
		const current = await app.vault.read(file);
		if (sameText(current, text)) return { result: "unchanged", path: await placeAt(app, file, path), worldName };
		if (!mayOverwriteBasesFile(current)) return { result: "kept", path: file.path, worldName };
		await app.vault.modify(file, text);
		return { result: "rewritten", path: await placeAt(app, file, path), worldName };
	}
	if (opts.create === false) return { result: "absent", path, worldName };
	await app.vault.create(path, text);
	return { result: "created", path, worldName };
}

export async function writeWorldBasesFile(app: App, worldFolder: string): Promise<BasesWriteResult> {
	return (await writeWorldBasesFileOutcome(app, worldFolder)).result;
}

/**
 * Write Bases file's form: as Download's, but a base the user changed (or
 * their own file at that path) is rebuilt too, and their version is first
 * kept beside it as `<folder> (your copy).base`, without the plugin's first
 * line, so the plugin never takes the copy for its own. A folder at the path
 * is still kept.
 */
export async function rebuildWorldBasesFile(app: App, worldFolder: string): Promise<BasesWriteOutcome> {
	const worldName = await worldNameOf(app, worldFolder);
	const text = worldBasesText(worldName, worldFolder);
	const path = basesFilePath(worldFolder);
	const found = await findWorldBase(app, worldFolder);
	if (found.blocked) return { result: "kept", path, worldName };
	const file = found.file;
	if (file) {
		const current = await app.vault.read(file);
		if (sameText(current, text)) return { result: "unchanged", path: await placeAt(app, file, path), worldName };
		let copy: string | undefined;
		if (!mayOverwriteBasesFile(current)) {
			copy = await freeCopyPath(app, worldFolder);
			await app.vault.create(copy, stripBasesMarker(current));
		}
		await app.vault.modify(file, text);
		return { result: "rewritten", path: await placeAt(app, file, path), worldName, copy };
	}
	await app.vault.create(path, text);
	return { result: "created", path, worldName };
}

/**
 * The hook Download World and Create World call: never fails the command it
 * rides on. With the plugin's settings (`memory`), the first time it keeps a
 * world's base because the user changed it, a Notice says so; the world is
 * remembered so the Notice shows once, and forgotten when the plugin owns
 * the file again. The first base it creates in this vault is announced once.
 */
export async function writeWorldBasesFileQuietly(app: App, worldFolder: string, memory?: BasesMemory): Promise<void> {
	try {
		const outcome = await writeWorldBasesFileOutcome(app, worldFolder);
		const noticed = memory?.settings.basesKeptNoticed ?? [];
		if (outcome.result === "kept") {
			console.info(`OnlyWorlds: ${outcome.path} was changed since the plugin wrote it; left alone.`);
			if (memory && !noticed.includes(worldFolder)) {
				new Notice(basesKeptNotice(outcome.worldName), 12000);
				memory.settings.basesKeptNoticed = [...noticed, worldFolder];
				await memory.saveSettings();
			}
			return;
		}
		if (!memory) return;
		let changed = false;
		if (noticed.includes(worldFolder)) {
			memory.settings.basesKeptNoticed = noticed.filter((w) => w !== worldFolder);
			changed = true;
		}
		if (outcome.result === "created" && !memory.settings.basesIntroShown) {
			new Notice(basesIntroNotice(outcome.worldName), 10000);
			memory.settings.basesIntroShown = true;
			changed = true;
		}
		if (changed) await memory.saveSettings();
	} catch (error) {
		console.error("OnlyWorlds: could not write the world's Bases file", error);
	}
}

/**
 * Rename World's step, after the folder moved: the world's base still names
 * the old folder in its filters. The plugin's own unchanged file is rewritten
 * for the new folder and renamed after the world; a base the user changed is
 * left as is, and a Notice says so, naming the rename. Never creates a base.
 */
export async function moveWorldBasesFileAfterRename(
	app: App,
	oldFolder: string,
	newFolder: string,
	memory?: BasesMemory
): Promise<void> {
	try {
		const outcome = await writeWorldBasesFileOutcome(app, newFolder, { create: false, alsoNamed: `${oldFolder}.base` });
		const noticed = memory?.settings.basesKeptNoticed ?? [];
		if (outcome.result === "kept") {
			new Notice(basesKeptNotice(outcome.worldName, true), 12000);
			if (memory && !noticed.includes(newFolder)) {
				memory.settings.basesKeptNoticed = [...noticed, newFolder];
				await memory.saveSettings();
			}
		} else if (memory && noticed.includes(newFolder)) {
			memory.settings.basesKeptNoticed = noticed.filter((w) => w !== newFolder);
			await memory.saveSettings();
		}
	} catch (error) {
		console.error("OnlyWorlds: could not update the world's Bases file after the rename", error);
	}
}
