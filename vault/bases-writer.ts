import { App, Notice, TFile, normalizePath } from "obsidian";
import { Category } from "../enums";
import { getCategorySchema } from "./element-transform";
import { buildBasesFile, mayOverwriteBasesFile, stripBasesMarker, type BasesSchema } from "./bases-file";
import type { OnlyWorldsPluginSettings } from "../settings/settings";

/**
 * Writing a world's Bases file into the vault (OW Infra #188). The text is
 * vault/bases-file.ts's; this is the Obsidian-facing half: where the file
 * goes, and the rule that the plugin overwrites only a file it wrote and
 * nobody changed since.
 */

export type BasesWriteResult = "created" | "rewritten" | "unchanged" | "kept";

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
	settings: Pick<OnlyWorldsPluginSettings, "basesKeptNoticed">;
	saveSettings(): Promise<void>;
}

/** The Notice Download shows the first time it keeps a world's base because the user changed it. */
export function basesKeptNotice(worldName: string): string {
	return `Your Bases file for ${worldName} has your own changes, so it was left as is; delete it or run Write Bases file to rebuild it.`;
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

/**
 * Write (or refresh) `<folder>.base` for the world in `OnlyWorlds/Worlds/<folder>`.
 * - no file there: created;
 * - the plugin's own file, unchanged since: rewritten (or "unchanged" when the text is the same);
 * - anything else at that path (a user's own base, the plugin's file edited,
 *   a folder): kept, untouched.
 */
export async function writeWorldBasesFileOutcome(app: App, worldFolder: string): Promise<BasesWriteOutcome> {
	const worldName = await worldNameOf(app, worldFolder);
	const text = worldBasesText(worldName, worldFolder);
	const path = basesFilePath(worldFolder);
	const done = (result: BasesWriteResult): BasesWriteOutcome => ({ result, path, worldName });
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		if (current.replace(/\r\n?/g, "\n") === text) return done("unchanged");
		if (!mayOverwriteBasesFile(current)) return done("kept");
		await app.vault.modify(existing, text);
		return done("rewritten");
	}
	if (existing) return done("kept");
	await app.vault.create(path, text);
	return done("created");
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
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		if (current.replace(/\r\n?/g, "\n") === text) return { result: "unchanged", path, worldName };
		let copy: string | undefined;
		if (!mayOverwriteBasesFile(current)) {
			copy = await freeCopyPath(app, worldFolder);
			await app.vault.create(copy, stripBasesMarker(current));
		}
		await app.vault.modify(existing, text);
		return { result: "rewritten", path, worldName, copy };
	}
	if (existing) return { result: "kept", path, worldName };
	await app.vault.create(path, text);
	return { result: "created", path, worldName };
}

/**
 * The hook Download World and Create World call: never fails the command it
 * rides on. With the plugin's settings (`memory`), the first time it keeps a
 * world's base because the user changed it, a Notice says so; the world is
 * remembered so the Notice shows once, and forgotten when the plugin owns
 * the file again.
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
		} else if (memory && noticed.includes(worldFolder)) {
			memory.settings.basesKeptNoticed = noticed.filter((w) => w !== worldFolder);
			await memory.saveSettings();
		}
	} catch (error) {
		console.error("OnlyWorlds: could not write the world's Bases file", error);
	}
}
