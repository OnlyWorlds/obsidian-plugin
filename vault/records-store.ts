import { App, normalizePath } from "obsidian";
import { RECORDS_DIR, type RecordFile } from "./records";

/**
 * Where a world's `records/` lives in the vault (OW Obsidian #577): inside the
 * world's folder, as `OnlyWorlds/Worlds/<world>/records/`, the same tree the
 * folder had, so the person sees their records beside World.md and Elements/,
 * a world renamed or moved in the vault takes them along, and the export finds
 * them where the import put them.
 *
 * Adapter I/O only, as bytes (readBinary/writeBinary): nothing is decoded,
 * re-encoded or renamed, so every record arrives and leaves byte for byte.
 * The adapter and not the vault: a producer's dot-files (`records/lab/.cursor`)
 * are files Obsidian's index never lists, and only the adapter reads, lists and
 * writes them. No other part of the plugin reads under `records/` (element
 * scans look under `Elements/`).
 */
export function worldRecordsRoot(world: string): string {
	return normalizePath(`OnlyWorlds/Worlds/${world}/${RECORDS_DIR}`);
}

/** Every file under `root`, recursively, dot-files included, as full vault paths sorted by code unit. */
export async function listTree(app: App, root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		const listed = await app.vault.adapter.list(dir);
		out.push(...listed.files);
		for (const sub of listed.folders) await walk(sub);
	};
	if (!(await app.vault.adapter.exists(root))) return [];
	await walk(normalizePath(root));
	return out.map((p) => normalizePath(p)).sort();
}

/**
 * The records under `root` (a folder's or a world's `records/`), each as
 * `records/<...>` relative to root's parent, its bytes as stored.
 */
export async function readRecordsTree(app: App, root: string): Promise<RecordFile[]> {
	const base = normalizePath(root);
	const files: RecordFile[] = [];
	for (const path of await listTree(app, base)) {
		const data = new Uint8Array(await app.vault.adapter.readBinary(path));
		files.push({ rel: `${RECORDS_DIR}/${path.slice(base.length + 1)}`, data });
	}
	return files;
}

/** Make `dir` and every missing parent, one segment at a time, through the adapter (a dot-folder too). */
export async function ensureAdapterDir(app: App, dir: string): Promise<void> {
	const norm = normalizePath(dir);
	if (!norm || norm === "/") return;
	let cur = "";
	for (const seg of norm.split("/")) {
		cur = cur ? `${cur}/${seg}` : seg;
		if (!(await app.vault.adapter.exists(cur))) await app.vault.adapter.mkdir(cur);
	}
}

/** Write record files under `parent` (each at `<parent>/<rel>`), byte for byte. */
export async function writeRecordFiles(app: App, parent: string, files: RecordFile[]): Promise<void> {
	for (const f of files) {
		const full = normalizePath(`${parent}/${f.rel}`);
		await ensureAdapterDir(app, full.substring(0, full.lastIndexOf("/")));
		await app.vault.adapter.writeBinary(full, f.data.slice().buffer);
	}
}
