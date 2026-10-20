/**
 * Elements hidden from this reader by the world's owner (OW Infra #426; keel's
 * hidden mark, Keel #421: the one rule's sheet §1 and §3, D124, D127, D128).
 * The pure core: no Obsidian import, tested under test/.
 *
 * keel answers a hidden id with 404, exactly as a missing one, so a member's
 * plugin learns of a hide in two ways only:
 *   - a feed delete row with `reason: "hidden"` (a contributor whose view
 *     started before the hide). The Captain's ruling (B12, h20 #8014): "A hide
 *     is the exception by its own row: `reason: hidden` says drop the copy and
 *     never offer to keep it";
 *   - a 409 `resync_required` with `reason: "view"` (a guest, or a contributor
 *     after a hide, an unhide, a delete or a Character change): what the walk
 *     from the start no longer names is dropped. `reason: "role"`, or no reason
 *     (keel with the mark off), keeps it: "keep what you hold that the new walk
 *     does not name" (D128).
 *
 * "Dropped" never deletes a note. The note becomes a stub (stubNote): the
 * element's fields emptied, the person's own writing kept byte for byte, one
 * line saying why. Its id goes on the world's hidden list
 * (settings.hiddenOnServer), so a save or an upload never sends it again.
 */
import {
	API_DROPPED_FIELDS,
	bodySpans,
	bodyTextFields,
	getCategorySchema,
	headingToFieldKey,
	isExtensionKey,
	joinNote,
	normalizeCategory,
	parseRawFrontmatterScalars,
	readsAsCustomField,
	splitNote,
} from "../vault/element-transform";

/** The line a stub holds where the element's fields were. */
export const HIDDEN_STUB_LINE = "Hidden by the world's owner.";
/** What a save of a stub, or of an id on the hidden list, says. */
export const HIDDEN_NOT_SAVED = "Hidden by the world's owner: not saved.";

/** Why keel asked for a walk from the start: `none` is a 409 that names no reason (keel with the mark off). */
export type ResyncReason = "role" | "view" | "none";

/**
 * The reason of keel's 409 `resync_required`, or null when `error` is not one.
 * The client reads `reason` inside the error envelope or beside it.
 */
export function resyncReasonOf(error: unknown): ResyncReason | null {
	const e = error as { status?: unknown; code?: unknown; reason?: unknown } | null;
	if (!e || e.status !== 409 || e.code !== "resync_required") return null;
	return e.reason === "role" || e.reason === "view" ? e.reason : "none";
}

/** Each line of `text` without its line ending. */
function linesOf(text: string): string[] {
	return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** The frontmatter keys that are the element's: its type's schema fields (those the API drops included), `name`, and every extension namespace. */
function elementKey(key: string, category: string): boolean {
	if (key === "name" || isExtensionKey(key)) return true;
	const schema = getCategorySchema(category);
	if (schema && key in schema) return true;
	return (API_DROPPED_FIELDS[normalizeCategory(category)] ?? []).includes(key);
}

/** A top-level YAML key at the start of `line`, its quotes taken off; null for a continuation, a comment or a list item. */
function topLevelKey(line: string): string | null {
	const m = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#\-"'][^:]*?))[ \t]*:(?:[ \t]|$)/.exec(line);
	if (!m) return null;
	return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * The frontmatter block with every element field emptied (`key:`, a link
 * list `key: []`) and every other entry kept as written: `id`, and the
 * person's own keys (`tags`, `aliases`, any key the format does not write).
 * Entries are cut at top-level keys; a continuation line (indented, a list
 * item, a comment) belongs to the entry above it.
 */
function emptyElementFields(block: string, category: string): string {
	const raw = block.split("\n");
	const cr = raw[0].endsWith("\r") ? "\r" : "";
	const schema = getCategorySchema(category);
	const out: string[] = [raw[0]];
	let dropping = false;
	for (const line of raw.slice(1, -1)) {
		const key = topLevelKey(line.endsWith("\r") ? line.slice(0, -1) : line);
		if (key !== null) {
			dropping = key !== "id" && elementKey(key, category);
			if (dropping) {
				out.push(`${key}:${schema?.[key]?.type === "multi_link" ? " []" : ""}${cr}`);
				continue;
			}
		}
		if (!dropping) out.push(line);
	}
	out.push(raw[raw.length - 1]);
	return out.join("\n");
}

/**
 * True when a `###` section is one of the element's fields as the format
 * reads it: a text field of the type, or a heading a save reads as a custom
 * field (`### Looks` -> `x_looks`). Any other heading (punctuation, more than
 * three words) is the person's own prose structure.
 */
function isFieldSection(heading: string, category: string): boolean {
	return bodyTextFields(category).includes(headingToFieldKey(heading)) || readsAsCustomField(heading);
}

/**
 * The body with every field section taken out and the stub line once where
 * the first one stood. The text before the first heading and every section
 * that is not a field are kept byte for byte. A body with no heading is the
 * description itself (the 3.0 format) and goes, unless it already holds the
 * stub line; a body that holds the stub line gains no second one.
 */
function stubBody(body: string, category: string): string {
	const spans = bodySpans(body);
	const hasStub = linesOf(body).includes(HIDDEN_STUB_LINE);
	if (spans.length === 1) return hasStub ? body : `${HIDDEN_STUB_LINE}\n`;
	let out = "";
	let placed = hasStub;
	spans.forEach((span, i) => {
		if (span.heading === null || !isFieldSection(span.heading, category)) {
			out += body.slice(span.start, span.end);
			return;
		}
		if (placed) return;
		placed = true;
		const keptAfter = spans.slice(i + 1).some((s) => s.heading !== null && !isFieldSection(s.heading, category));
		out += `${HIDDEN_STUB_LINE}${span.eol}${keptAfter ? span.eol : ""}`;
	});
	return out;
}

/**
 * The stub of an element note: the element's fields (frontmatter and the
 * body's field sections) emptied, the stub line where the sections were,
 * everything else as the person wrote it. A note with no element id is
 * returned as it is (a person's own note), and so is a stub (idempotent).
 * The frontmatter lands at byte 0 through joinNote, as every write does.
 */
export function stubNote(content: string, category: string): string {
	const { frontmatter, body } = splitNote(content);
	if (!frontmatter || !parseRawFrontmatterScalars(frontmatter, ["id"]).id) return content;
	const next = joinNote(emptyElementFields(frontmatter, category), stubBody(body, category));
	return next === content ? content : next;
}

/**
 * True when `content` is a stub: it carries an element id and no name, and
 * its body holds the stub line. A save or an upload never sends one, even
 * when the hidden list was lost (data.json outlives no reinstall).
 */
export function isStubNote(content: string): boolean {
	const { frontmatter, body } = splitNote(content);
	if (!frontmatter) return false;
	const fm = parseRawFrontmatterScalars(frontmatter, ["id", "name"]);
	return !!fm.id && !fm.name && linesOf(body).includes(HIDDEN_STUB_LINE);
}

/** A change of the feed as this reads it. */
export interface HiddenChange {
	id: string;
	op: string;
	reason?: string | null;
}

export interface HiddenPlan {
	/** The world's hidden list after this walk (Download prunes it to ids with a note or a link here). */
	hidden: Set<string>;
	/** Notes here that a hidden row names: each becomes a stub. */
	stubHidden: string[];
	/** Notes here that a view resync's walk does not name: each becomes a stub. */
	stubView: string[];
	/** The ids this device knows on the server after this walk. */
	known: Set<string>;
}

/**
 * What one Download does about hidden elements. `latest` is the walk folded
 * to one change per id, later ops winning, so an unhide (an upsert after the
 * hidden row) takes the id off the list.
 *
 * A view resync stubs only notes whose ids this device KNOWS were on the
 * server (`storedKnown`: every id a Download's walk upserted, kept per world):
 * a note made here and not yet saved has an element id but was never on the
 * server, and the walk not naming it says nothing. A role resync, or one with
 * no reason, stubs nothing; what its walk no longer names leaves the known set
 * for good, so a later view resync never takes it either (B12: kept).
 */
export function planHidden(o: {
	latest: Iterable<HiddenChange>;
	storedHidden?: Iterable<string>;
	storedKnown?: Iterable<string>;
	/** The walk read the feed from the start: its upserts are everything in view. */
	fromStart: boolean;
	/** The reason of the 409 that forced the walk from the start, or null. */
	resync: ResyncReason | null;
	/** The element ids of this world's notes here. */
	ownIds: Set<string>;
}): HiddenPlan {
	const latest = new Map<string, HiddenChange>();
	for (const c of o.latest) latest.set(c.id, c);
	const storedHidden = new Set(o.storedHidden ?? []);
	const hidden = new Set(storedHidden);
	const stubHidden: string[] = [];
	const known = o.fromStart ? new Set<string>() : new Set(o.storedKnown ?? []);
	for (const [id, c] of latest) {
		if (c.op === "delete" && c.reason === "hidden") {
			hidden.add(id);
			if (o.ownIds.has(id)) stubHidden.push(id);
		} else {
			hidden.delete(id);
		}
		if (c.op === "delete") known.delete(id);
		else known.add(id);
	}
	const stubView: string[] = [];
	if (o.resync === "view") {
		for (const id of o.storedKnown ?? []) {
			if (latest.has(id) || storedHidden.has(id) || !o.ownIds.has(id)) continue;
			stubView.push(id);
			hidden.add(id);
		}
	}
	return { hidden, stubHidden, stubView, known };
}

/** The download's sentences for the notes it stubbed, each apart from the deleted count. */
export function hiddenNotices(hidden: number, view: number): string[] {
	const tail = (n: number) => (n === 1 ? "its note now holds only your own writing." : "their notes now hold only your own writing.");
	const out: string[] = [];
	if (hidden > 0) out.push(`${hidden} element${hidden === 1 ? " was" : "s were"} hidden by the world's owner; ${tail(hidden)}`);
	if (view > 0) out.push(`${view} element${view === 1 ? "" : "s"} left your view; ${tail(view)}`);
	return out;
}

/** True when any world's hidden list holds `id` (an element id belongs to one world). */
export function isHiddenId(settings: { hiddenOnServer?: Record<string, string[]> }, id: string): boolean {
	return Object.values(settings.hiddenOnServer ?? {}).some((list) => list.includes(id));
}
