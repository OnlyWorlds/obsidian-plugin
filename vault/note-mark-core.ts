/**
 * The note mark: PURE logic, NO Obsidian imports (unit-tested under `npm test`).
 *
 * A pull replaces a changed element's note, so a person's edit that was never saved would go
 * with it. To tell such a note, the change_seq index (`.ow-seq.json`) keeps one more number beside
 * an id's change_seq and its `^` mark: `<id>#`, a hash of the note's whole bytes as the last pull
 * or save left them. A note whose bytes no longer hash to it holds edits that pull or save has
 * not seen: the pull copies it whole into `Kept edits/` before it writes the world's copy, and
 * says so. No entry (a vault from before, a note an upload just sent, a save that could not
 * tell) proves nothing, so the pull copies that note too, and the mark it then writes is the
 * next pull's baseline. Nothing here measures
 * what a pull would lose: any difference is reason enough for a copy, and a copy costs a file.
 *
 * The hash is cyrb53 (a non-cryptographic 53-bit hash): the index holds whole numbers only, and
 * a collision costs one copy not made, which is today's behaviour.
 */

/** The index key of an id's note mark. */
export function markKey(id: string): string {
	return `${id}#`;
}

/** The mark of a note's bytes: a whole number below 2^53. */
export function noteMark(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * True unless the note is provably what the last pull or save left: a mark is recorded and the bytes still match it. A note with
 * no mark (a vault from before, an upload, a save that could not tell) is copied too: nothing proves it holds nothing unseen,
 * and a copy costs a file.
 */
export function holdsUnsavedEdits(text: string, recorded: number | undefined | null): boolean {
	return !(typeof recorded === "number" && noteMark(text) === recorded);
}

/** The folder of the copies, under the world's folder. A person's own notes live there: it holds no element note. */
export const KEPT_FOLDER = "Kept edits";

/**
 * A name shortened to at most `maxBytes` of UTF-8 (by whole characters), so the copy's file name, which adds the moment and
 * the extension, stays inside a file system's limit of 255 bytes (a name in Chinese or Japanese is three bytes a character).
 */
export function capKeptName(name: string, maxBytes = 100): string {
	const encoder = new TextEncoder();
	let out = "";
	let bytes = 0;
	for (const ch of name) {
		const n = encoder.encode(ch).length;
		if (bytes + n > maxBytes) break;
		out += ch;
		bytes += n;
	}
	return out.trim() || "unnamed";
}

/**
 * A copy's file name: the note's name and the moment, never the note's own file name (two notes of one name make a bare
 * link to the element ambiguous). `when` is local time.
 */
export function keptCopyName(name: string, when: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${name} (kept ${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}${p(when.getMinutes())})`;
}

/**
 * The note as a copy holds it: every byte as it was, but the front matter's `id` key renamed `kept_from`, so no reader takes
 * the copy for the element (a note whose `id` is a UUID is an element note wherever it sits). `kept_from` is no element key:
 * the copy is a person's own note.
 */
export function asKeptCopy(text: string): string {
	// The block may follow a byte-order mark or blank space, as the readers of an element's id allow.
	const open = /^[﻿\s]*---\r?\n/.exec(text);
	if (!open) return text;
	const rest = text.slice(open[0].length);
	const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(rest);
	const end = close ? close.index : rest.length;
	return text.slice(0, open[0].length) + rest.slice(0, end).replace(/^(["']?)id\1(\s*):/m, "kept_from$2:") + rest.slice(end);
}

/** The one notice of a pull that copied notes: `labels` are the notes' labels. */
export function copiedMessage(labels: string[]): string {
	const shown = labels.slice(0, 3).join(", ");
	const more = labels.length > 3 ? ` +${labels.length - 3} more` : "";
	const one = labels.length === 1;
	return `Download wrote the world's copy over ${labels.length} note${one ? "" : "s"} that held edits it had not seen: ${shown}${more}. ` +
		`${one ? "The note" : "Each note"} as it was is kept whole in ${KEPT_FOLDER}/ in the world's folder.`;
}

/**
 * The group marks: which entries of the world's group (`x_properties`) the note holds because the world showed them, so a
 * pull can tell an entry another client removed from one a person typed. Beside an id's number, the index keeps one entry
 * per group key the last pull or save wrote: `<id>~<key>`, the hash of the value the note held for it then. At a pull, a
 * note property that has such a mark, whose value still hashes to it, and that the arriving group no longer holds, is the
 * world's entry that left: it leaves the note. A value the person changed since keeps its note (the next save sends it);
 * a key with no mark (typed by hand, a vault from before) is never dropped.
 */
export function groupMarkKey(id: string, key: string): string {
	return `${id}~${key}`;
}

/** The mark of one property value, as the note holds it once read back. */
export function valueMark(value: unknown): number {
	return noteMark(JSON.stringify(value === undefined ? null : value));
}

function isGroup(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The index's group marks by id: built once per run, never searched per id. */
export type GroupKeysById = Map<string, string[]>;

export function groupKeysById(index: Record<string, number>): GroupKeysById {
	const out: GroupKeysById = new Map();
	for (const entry of Object.keys(index)) {
		const at = entry.indexOf("~");
		if (at <= 0) continue;
		const id = entry.slice(0, at);
		const list = out.get(id);
		if (list) list.push(entry.slice(at + 1));
		else out.set(id, [entry.slice(at + 1)]);
	}
	return out;
}

/**
 * The keys of a note's own properties the world's group held at the last pull or save and no longer holds, unchanged since.
 * Only an element that arrives with its group (an object) or with it cleared (null) says anything: no `x_properties` key at
 * all is no news, as the writer reads it.
 */
export function removedGroupKeys(
	id: string,
	serverGroup: unknown,
	noteProps: Record<string, unknown>,
	index: Record<string, number>,
): string[] {
	if (serverGroup !== null && !isGroup(serverGroup)) return [];
	const arriving = isGroup(serverGroup) ? serverGroup : {};
	const out: string[] = [];
	for (const key of Object.keys(noteProps)) {
		if (Object.prototype.hasOwnProperty.call(arriving, key)) continue;
		const recorded = index[groupMarkKey(id, key)];
		if (typeof recorded === "number" && valueMark(noteProps[key]) === recorded) out.push(key);
	}
	return out;
}

/**
 * The index entries that follow a note's write: a mark for each key of the group the note now holds as the world's, and a
 * clear for every key of the id the index still marks and the note no longer holds that way. `noteProps` is the note's
 * front matter read back after the write. A key the writer kept inside the note's own `x_properties` (a name the note's
 * profile keys already hold: `tags`, a tool's key) is not a property of the note's: the property of that name is the
 * person's, and gets no mark.
 */
export function groupMarkEntries(
	id: string,
	serverGroup: unknown,
	noteProps: Record<string, unknown>,
	known: GroupKeysById,
): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	const held = new Set<string>();
	const kept = isGroup(noteProps.x_properties) ? noteProps.x_properties : {};
	if (isGroup(serverGroup)) {
		for (const key of Object.keys(serverGroup)) {
			if (!Object.prototype.hasOwnProperty.call(noteProps, key)) continue;
			if (Object.prototype.hasOwnProperty.call(kept, key)) continue;
			out[groupMarkKey(id, key)] = valueMark(noteProps[key]);
			held.add(key);
		}
	}
	for (const key of known.get(id) ?? []) if (!held.has(key)) out[groupMarkKey(id, key)] = null;
	return out;
}

/** Clears for every group mark an id has in the index (an upload that holds no note's bytes, a delete). */
export function groupMarkClears(id: string, known: GroupKeysById): Record<string, null> {
	const out: Record<string, null> = {};
	for (const key of known.get(id) ?? []) out[groupMarkKey(id, key)] = null;
	return out;
}
