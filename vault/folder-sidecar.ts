import { App, normalizePath } from "obsidian";

/**
 * The folder sidecar: `.ow-folder.json` inside a world folder (OW Infra #166).
 *
 * What an imported OnlyWorlds folder carried that the notes have no home for,
 * kept so the folder export writes it back instead of dropping it (spec §4.1:
 * a writer MUST NOT drop data it has):
 *   - `world`: the imported world.json minus `api` (world-json.ts; row 5).
 *   - `elements`: per element id, the body keys a note has no home for, the
 *     server's and Atlas's own fields (folder-format.ts splitCarriedFields;
 *     row 6). Never in the note: an upload must not send them.
 *   - `order`: per element id, its file's key order, so the export writes
 *     keys as received (spec §5; Kael's review).
 *
 * Adapter I/O only, for the reasons world-id-marker.ts gives: Obsidian's vault
 * index skips dot-prefixed files, and an unindexed file fires no vault events.
 */
export interface FolderSidecar {
	world?: Record<string, unknown>;
	/**
	 * What a Download read from the server (3.8.0): its origin and `GET
	 * /world`'s body as served, rewritten at every Download. The folder export
	 * of a downloaded world starts from it (vault/world-json.ts).
	 */
	server?: { server: string; world: Record<string, unknown> };
	elements?: Record<string, Record<string, unknown>>;
	order?: Record<string, string[]>;
}

function sidecarPath(world: string): string {
	return normalizePath(`OnlyWorlds/Worlds/${world}/.ow-folder.json`);
}

/** The sidecar, or an empty one when absent or unreadable. */
export async function readFolderSidecar(app: App, world: string): Promise<FolderSidecar> {
	const path = sidecarPath(world);
	try {
		if (!(await app.vault.adapter.exists(path))) return {};
		const parsed = JSON.parse(await app.vault.adapter.read(path));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FolderSidecar) : {};
	} catch {
		return {};
	}
}

/** Write the sidecar whole (the world folder must exist). */
export async function writeFolderSidecar(app: App, world: string, sidecar: FolderSidecar): Promise<void> {
	await app.vault.adapter.write(sidecarPath(world), JSON.stringify(sidecar, null, 2) + "\n");
}
