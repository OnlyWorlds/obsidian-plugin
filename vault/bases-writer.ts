import { App, TFile, normalizePath } from "obsidian";
import { Category } from "../enums";
import { getCategorySchema } from "./element-transform";
import { buildBasesFile, mayOverwriteBasesFile, type BasesSchema } from "./bases-file";

/**
 * Writing a world's Bases file into the vault (OW Infra #188). The text is
 * vault/bases-file.ts's; this is the Obsidian-facing half: where the file
 * goes, and the rule that the plugin overwrites only a file it wrote and
 * nobody changed since.
 */

export type BasesWriteResult = "created" | "rewritten" | "unchanged" | "kept";

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

/**
 * Write (or refresh) `<folder>.base` for the world in `OnlyWorlds/Worlds/<folder>`.
 * - no file there: created;
 * - the plugin's own file, unchanged since: rewritten (or "unchanged" when the text is the same);
 * - anything else at that path (a user's own base, the plugin's file edited,
 *   a folder): kept, untouched.
 */
export async function writeWorldBasesFile(app: App, worldFolder: string): Promise<BasesWriteResult> {
	const text = buildBasesFile({
		worldName: await worldNameOf(app, worldFolder),
		worldFolderPath: normalizePath(`OnlyWorlds/Worlds/${worldFolder}`),
		schema: pluginBasesSchema(),
	});
	const path = basesFilePath(worldFolder);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		const current = await app.vault.read(existing);
		if (current.replace(/\r\n?/g, "\n") === text) return "unchanged";
		if (!mayOverwriteBasesFile(current)) return "kept";
		await app.vault.modify(existing, text);
		return "rewritten";
	}
	if (existing) return "kept";
	await app.vault.create(path, text);
	return "created";
}

/**
 * The hook Download World and Create World call: never fails the command it
 * rides on, says nothing when it kept a user's file (the command form says so).
 */
export async function writeWorldBasesFileQuietly(app: App, worldFolder: string): Promise<void> {
	try {
		const result = await writeWorldBasesFile(app, worldFolder);
		if (result === "kept") {
			console.info(`OnlyWorlds: ${basesFilePath(worldFolder)} was changed since the plugin wrote it; left alone.`);
		}
	} catch (error) {
		console.error("OnlyWorlds: could not write the world's Bases file", error);
	}
}
