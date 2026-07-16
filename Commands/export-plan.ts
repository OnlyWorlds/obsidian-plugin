/**
 * Export destination planning — PURE logic (S9 export picker).
 *
 * No Obsidian, node, or Electron imports: this module is unit-tested under plain
 * `node --test` (like vault/folder-format.ts). The command file owns the actual
 * I/O — the native directory picker probe, the fs/promises external sink, and the
 * vault-API internal sink. This module only decides paths and refusal reasons so
 * that the escape-the-vault question and the R3 safety refusals are testable
 * without a running Obsidian.
 */

/** Where an export lands. `vault` = current behavior; `external` = a real OS dir. */
export type ExportDestination =
	| { kind: "vault" }
	| { kind: "external"; dir: string };

/**
 * Join an absolute external directory with a world folder name, POSIX or Windows.
 *
 * The dialog hands back a native absolute path (`C:\Users\…\onlyworlds-atlas` on
 * Windows, `/home/…/onlyworlds-atlas` on POSIX). We must NOT route this through
 * Obsidian's normalizePath — that lowercases nothing but strips the drive-letter
 * colon handling we need and is meant for vault-relative paths. Instead join with
 * the separator already present in the parent, defaulting to the platform's.
 */
export function joinExternal(dir: string, folderName: string, sep: string): string {
	const trimmed = dir.replace(/[\\/]+$/, "");
	return `${trimmed}${sep}${folderName}`;
}

/** Reasons an external target is refused before any bytes are written (R3). */
export type ExternalRefusal =
	| { ok: true }
	| { ok: false; reason: "exists"; message: string }
	| { ok: false; reason: "atlas-open"; message: string };

/**
 * Decide whether an external target folder is safe to write, given cheap probe
 * results the caller gathered with fs (R3):
 *   - `targetExists`: does `<dest>/<folderName>/` already exist?
 *   - `destHasAtlasLock`: does the CHOSEN destination dir contain a top-level
 *     `.atlas` dir or a `lock` file? (an Atlas world held open — the race class)
 *
 * Refuses on either. Pure so the branch logic is test-covered; the caller does
 * the fs.stat / readdir and passes the booleans in.
 */
export function checkExternalTarget(
	folderName: string,
	targetExists: boolean,
	destHasAtlasLock: boolean
): ExternalRefusal {
	if (destHasAtlasLock) {
		return {
			ok: false,
			reason: "atlas-open",
			message:
				"That folder looks like an Atlas world that's currently open " +
				"(it contains a .atlas or lock file). Close Atlas or pick its parent " +
				"root instead, then re-run the export.",
		};
	}
	if (targetExists) {
		return {
			ok: false,
			reason: "exists",
			message:
				`A folder named ${folderName} already exists there. Move or delete it ` +
				"first — export never overwrites an existing folder.",
		};
	}
	return { ok: true };
}

/** The dotfile/lockfile names that mark a folder as an Atlas world held open. */
export const ATLAS_OPEN_MARKERS = [".atlas", "lock"] as const;
