/**
 * A world's folder name — PURE logic, no Obsidian imports (Kael's review 3.7).
 *
 * A world's name reaches the disk as `OnlyWorlds/Worlds/<name>/`. It comes from
 * places the user does not write: a server's world (Download, a join link a
 * stranger made), a folder's world.json (Import), a paste. So every path that
 * names a world folder passes it through here first, and the result is always
 * ONE safe path segment:
 *   - no `/` or `\` (no second segment), no `:` (a Windows drive or stream),
 *     none of Windows' other reserved characters `* ? " < > |`, no control
 *     characters: each becomes `-`, as element filenames do (sanitizeFileName);
 *   - no leading dot (`.`/`..` climb, and Obsidian hides dot folders) and no
 *     trailing dot or space (Windows drops them, so two names would share a
 *     folder); trimmed;
 *   - not a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9);
 *   - never empty: "Untitled world".
 * The world keeps its real name everywhere that is not a path (World.md's Name
 * line, the server, an export's world.json).
 */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_LEN = 120;

export function safeWorldFolderName(name: string): string {
	let s = String(name ?? "")
		.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-")
		.trim()
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/[.\s]+$/, "");
	if (!s) return "Untitled world";
	if (RESERVED_DEVICE.test(s)) s = s.replace(/^([^.]*)/, "$1_"); // "con" -> "con_", "nul.x" -> "nul_.x"
	return s;
}
