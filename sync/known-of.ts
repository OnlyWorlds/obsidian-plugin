/**
 * Known-of elements (OW Infra #454; the folder spec §4.4, ruled 2026-10-20;
 * keel PR 113 and PR 117, the one rule §7g). The pure core: no Obsidian
 * import, tested under test/.
 *
 * keel serves a guest some elements as "known of": a stub marked
 * `known_of: true` that keeps a few keys (the name, the description, the kind,
 * the picture; a Character's public fields too) and reads every other field
 * as an unset one reads ("", null, []). On a note, those empty fields would
 * look like a whole element with nothing filled in, and a save would send
 * the stub back over the real element. So:
 *
 *   1. a stub is written as it is: `known_of: true` and only the keys it
 *      keeps, every unset field left out (never "", null or []);
 *   2. a note carrying `known_of: true` is read as known of: what it leaves
 *      out is unknown, not empty;
 *   3. a known-of note is never pushed, by any path;
 *   4. a stub that later arrives whole is written whole, and `known_of` goes;
 *   5. a whole note whose element arrives as a stub follows the reset that
 *      brought it: after a `view` reset the stub replaces the whole copy;
 *      after a `role` reset, or with no reset, the whole copy is kept as last
 *      known (the Captain's B12 ruling: a member keeps what they had).
 *
 * The kept keys are never listed here: a stub keeps every key whose value is
 * not an unset one, whatever keel decides a stub keeps.
 */
import { bodySpans, bodyTextFields, headingToFieldKey, parseRawFrontmatterScalars, splitNote } from "../vault/element-transform";
import { isStubNote, stubKeptText, type ResyncReason } from "./hidden-on-server";

/** The frontmatter key (and wire key) that marks a stub. */
export const KNOWN_OF_KEY = "known_of";

/** The line a known-of note shows above its fields, so its empty fields are not taken for empty. */
export const KNOWN_OF_LINE = "Known of: you know of this element, not all of it. A field not shown here is unknown, not empty.";

/** What a save of a known-of note says (Save Element always; auto-sync once a session per note). */
export const KNOWN_OF_NOT_SAVED = "Known of: this note is not sent. What you add to it stays in this vault; its fields follow the next Download.";

/**
 * What a save of a whole note kept as last known says (rule 5, a role reset
 * or none): keel now serves its element as a stub, and the note is the
 * person's record of what they had (h37 #8936, 4).
 */
export const LAST_KNOWN_NOT_SAVED = "Known of now: this note keeps what you knew in full, and is not sent.";

/** True when a wire element (a feed row's element, a pasted or folder element) is a known-of stub. */
export function isKnownOfElement(element: unknown): boolean {
	return !!element && typeof element === "object" && (element as Record<string, unknown>)[KNOWN_OF_KEY] === true;
}

/**
 * The keys every stub keeps, written even when empty (keel's `KNOWN_OF_BASE`;
 * ow-folder-store's `knownOfBody` and Python's `known_of_for_disk` write the
 * same set: h37 #8936, 6). A note holds the six of them that are note keys.
 */
export const KNOWN_OF_KEEPS: ReadonlySet<string> = new Set([
	"id", "type", "name", "description", "supertype", "subtype", "image_url", "created_at", "updated_at", "change_seq",
]);

/** A value is anything but "", null and []: 0, false and whitespace are values (the reference writers' `_is_set`). */
export function isSetValue(value: unknown): boolean {
	return !(value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0));
}

/**
 * A stub's kept keys: every KNOWN_OF_KEEPS key, and every other key but
 * `known_of` whose value is set. Rule 1, as the reference writers read it.
 */
export function knownOfKept(element: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(element)) {
		if (k === KNOWN_OF_KEY) continue;
		if (KNOWN_OF_KEEPS.has(k) || isSetValue(v)) out[k] = v;
	}
	return out;
}

/** Each line of `text` without its line ending. */
function linesOf(text: string): string[] {
	return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * True when `content` is a known-of note: its frontmatter carries
 * `known_of: true`, or it carries an element id and its body the known-of
 * line (the key taken out by hand still never makes the stub pushable).
 * Rule 2 and rule 3 read this.
 */
export function isKnownOfNote(content: string): boolean {
	const { frontmatter, body } = splitNote(content);
	if (!frontmatter) return false;
	// YAML true as the plugin's reader (js-yaml 4, the core schema) reads it:
	// `true`, `True` or `TRUE`, unquoted, a comment allowed after it (h37 #8936, 7).
	if (/^known_of[ \t]*:[ \t]*(?:true|True|TRUE)[ \t]*(?:#.*)?\r?$/m.test(frontmatter)) return true;
	const fm = parseRawFrontmatterScalars(frontmatter, ["id"]);
	return !!fm.id && linesOf(body).includes(KNOWN_OF_LINE);
}

/** `text` without the known-of line (and the blank line after it), every other byte as it is. */
export function withoutKnownOfLine(text: string): string {
	const lines = text.split("\n").map((l, i, all) => (i < all.length - 1 ? `${l}\n` : l));
	const bare = (l: string) => l.replace(/\r?\n$/, "");
	const at = lines.findIndex((l) => bare(l) === KNOWN_OF_LINE);
	if (at < 0) return text;
	const drop = at + 1 < lines.length && bare(lines[at + 1]) === "" ? 2 : 1;
	return [...lines.slice(0, at), ...lines.slice(at + drop)].join("");
}

/**
 * The person's own writing a note carries that the next write must keep:
 * for a known-of note, what sits above its first field section without the
 * known-of line; for a hidden stub, what the stub kept (stubKeptText), without
 * the known-of line; "" for anything else, or when that is only whitespace.
 * Download and Paste World hand it to the one writer as `keepAbove`.
 */
export function knownOfKeptText(content: string): string {
	let kept = "";
	if (isStubNote(content)) kept = stubKeptText(content);
	else if (isKnownOfNote(content)) {
		const body = splitNote(content).body;
		const first = bodySpans(body)[0];
		kept = body.slice(first.start, first.end);
	}
	kept = withoutKnownOfLine(kept);
	return kept.trim() ? kept : "";
}

/**
 * The sections of a known-of note that are the person's own, byte for byte:
 * every `###` section whose heading names no text field of the type, and no
 * custom field `data` carries (`### Looks` when `x_looks` arrives). The next
 * write of the note puts them back after its fields, as stubBody keeps a
 * hidden stub's (h37 #8936, 3). "" for any other note.
 */
export function knownOfOwnSections(content: string, category: string, data: Record<string, unknown> = {}): string {
	if (!isKnownOfNote(content) || isStubNote(content)) return "";
	const body = splitNote(content).body;
	const fields = new Set(bodyTextFields(category));
	let out = "";
	for (const span of bodySpans(body)) {
		if (span.heading === null) continue;
		const key = headingToFieldKey(span.heading);
		if (fields.has(key) || `x_${key}` in data) continue;
		out += body.slice(span.start, span.end);
	}
	return out;
}

/** True when any world's last-known list holds `id` (a whole note kept over a stub). */
export function isLastKnownId(settings: { lastKnown?: Record<string, string[]> }, id: string): boolean {
	return Object.values(settings.lastKnown ?? {}).some((list) => list.includes(id));
}

/** The world's last-known list after a pull: the stored ids and those kept now, less every id the pull wrote. */
export function nextLastKnown(stored: Iterable<string>, kept: Iterable<string>, written: Iterable<string>): string[] {
	const out = new Set([...stored, ...kept]);
	for (const id of written) out.delete(id);
	return [...out];
}

/** What a note here is, as a known-of write reads it. */
export type NoteState = "none" | "whole" | "known_of" | "hidden_stub";

/** The state of the note `content` (null: no note here). */
export function noteStateOf(content: string | null): NoteState {
	if (content === null) return "none";
	if (isStubNote(content)) return "hidden_stub";
	if (isKnownOfNote(content)) return "known_of";
	return "whole";
}

/** What one arriving element does to its note: written whole, written as a stub, or the note kept as it is. */
export type KnownOfWrite = "whole" | "stub" | "keep";

/**
 * Rules 1, 4 and 5 for one arriving element. A whole element is written
 * whole (a known-of note becomes whole, `known_of` gone). A stub is written
 * as a stub over no note, a known-of note or a hidden stub; over a whole
 * note only after a `view` reset; after a `role` reset or with none, the
 * whole note is kept as last known.
 */
export function knownOfWrite(element: unknown, state: NoteState, resync: ResyncReason | null): KnownOfWrite {
	if (!isKnownOfElement(element)) return "whole";
	if (state !== "whole") return "stub";
	return resync === "view" ? "stub" : "keep";
}

/**
 * Download's sentences: notes that became known of this time (a new note,
 * or a whole copy a view reset replaced), and whole notes kept as last known.
 * A known-of note written again says nothing.
 */
export function knownOfNotices(became: number, keptWhole: number): string[] {
	const out: string[] = [];
	if (became > 0) {
		out.push(
			`${became} element${became === 1 ? " is" : "s are"} known of: ${became === 1 ? "its note shows" : "their notes show"} only what you know, and what you add to ${became === 1 ? "it" : "them"} stays in this vault.`
		);
	}
	if (keptWhole > 0) {
		out.push(
			`${keptWhole} element${keptWhole === 1 ? "" : "s"} you knew in full ${keptWhole === 1 ? "is" : "are"} now known of: your ${keptWhole === 1 ? "note keeps" : "notes keep"} what you had.`
		);
	}
	return out;
}
