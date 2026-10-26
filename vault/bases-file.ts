/**
 * A world's Bases file — PURE logic, no Obsidian imports.
 *
 * Obsidian's core Bases plugin (1.9+) reads a `.base` file: YAML with
 * `filters`, `formulas`, `properties` and `views` (Obsidian help, "Bases
 * syntax"). The plugin writes one per world, `<world folder>.base` beside
 * World.md, so every element type gets a table and a card view with nothing
 * to install:
 *   - a global filter scopes it to the world's Elements folder, Markdown only;
 *   - a formula `element_type` reads the type from the category folder's name
 *     (`Elements/Character (12)/x.md` -> `Character`): element notes carry no
 *     type property, their folder is their type;
 *   - "All elements": name, type, supertype, subtype;
 *   - per type, "<Plural>": name, supertype, subtype, then the type's
 *     frontmatter fields (numbers and links; text fields live in the note body
 *     and are no property) in schema order, at most MAX_TYPE_COLUMNS of them;
 *     and "<Plural> (cards)", its cover image `image_url` when the type has one.
 *
 * Per-type views filter on the folder, not the formula: `file.inFolder` and
 * `startsWith` are documented functions, so a view still works if the formula
 * misreads. A category folder is `Character`, the profile's address;
 * a vault from 3.8.1 or earlier may still hold `Character (12)` until
 * a Download renames it (vault/plain-folders.ts), or keep one beside the plain
 * folder when a name clash stopped the merge: both are matched, so no view
 * goes blank on the way.
 *
 * The first line is a marker with a hash of the rest. The plugin rewrites the
 * file only when the marker is there AND the hash still matches: a user who
 * changes anything (by hand, or by Obsidian rewriting it from the Bases UI,
 * which drops YAML comments) owns the file from then on.
 */

export type BasesSchema = Record<string, Record<string, { type: string }>>;

export interface BasesFileInput {
	/** The world's own name (World.md's Name line), for the header comment. */
	worldName: string;
	/** Vault path of the world folder, e.g. `OnlyWorlds/Worlds/Hyperion`. */
	worldFolderPath: string;
	/** Category (folder name, e.g. `Character`) -> its fields, in schema order. */
	schema: BasesSchema;
}

/** How many of a type's own fields its table shows, after name, supertype, subtype. */
export const MAX_TYPE_COLUMNS = 8;

const FORMAT_VERSION = 1;
const MARKER_TEXT =
	"# OnlyWorlds Builder wrote this file. Download world rewrites it; change anything and the plugin leaves it alone.";
const MARKER_RE = /^# OnlyWorlds Builder wrote this file\..* owb-bases:(\d+):([0-9a-f]{8})\s*$/;

/** Base keys every table opens with, never repeated among a type's own fields. */
const BASE_KEYS = new Set(["name", "id", "supertype", "subtype", "image_url", "description", "story"]);

const PLURALS: Record<string, string> = {
	Ability: "Abilities",
	Family: "Families",
	Phenomenon: "Phenomena",
	Species: "Species",
};

function plural(category: string): string {
	return PLURALS[category] ?? `${category}s`;
}

/** `birth_date` -> `Birth Date` (as element-transform's fieldToHeading; kept local so this file has no imports). */
function displayName(key: string): string {
	return key
		.split("_")
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/** A YAML double-quoted scalar (JSON's string syntax is valid YAML). */
function yq(s: string): string {
	return JSON.stringify(s);
}

/** A YAML single-quoted scalar: the form the Bases docs use for expressions. */
function ysq(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/** A string literal inside a Bases expression. */
function lit(s: string): string {
	return JSON.stringify(s);
}

/** The type's own frontmatter fields, in schema order, capped. */
function typeColumns(fields: Record<string, { type: string }>): string[] {
	return Object.entries(fields)
		.filter(([key, f]) => f.type !== "text" && !BASE_KEYS.has(key))
		.map(([key]) => key)
		.slice(0, MAX_TYPE_COLUMNS);
}

/** FNV-1a 32-bit, hex: enough to tell "unchanged since written" from "changed". */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

function normalizeEol(s: string): string {
	return s.replace(/\r\n?/g, "\n");
}

export function buildBasesFile(input: BasesFileInput): string {
	const world = input.worldFolderPath.replace(/\/+$/, "");
	const elements = `${world}/Elements`;
	const categoryIndex = world.split("/").length + 1;

	const lines: string[] = [];
	lines.push(`# World: ${input.worldName.replace(/[\r\n]+/g, " ")}`);
	lines.push("filters:");
	lines.push("  and:");
	lines.push(`    - ${ysq(`file.inFolder(${lit(elements)})`)}`);
	lines.push(`    - ${ysq(`file.ext == ${lit("md")}`)}`);
	lines.push("formulas:");
	lines.push(`  element_type: ${ysq(`file.folder.split(${lit("/")})[${categoryIndex}].split(${lit(" (")})[0]`)}`);

	// Display names: the fixed columns, then each type field once, first seen first.
	const props: Array<[string, string]> = [
		["file.name", "Name"],
		["formula.element_type", "Type"],
		["supertype", "Supertype"],
		["subtype", "Subtype"],
	];
	const seen = new Set(props.map(([k]) => k));
	const columnsByType = new Map<string, string[]>();
	for (const [category, fields] of Object.entries(input.schema)) {
		const cols = typeColumns(fields);
		columnsByType.set(category, cols);
		for (const key of cols) {
			if (seen.has(key)) continue;
			seen.add(key);
			props.push([key, displayName(key)]);
		}
	}
	lines.push("properties:");
	for (const [key, name] of props) {
		lines.push(`  ${key}:`);
		lines.push(`    displayName: ${yq(name)}`);
	}

	const order = (keys: string[]): string[] => ["    order:", ...keys.map((k) => `      - ${k}`)];
	lines.push("views:");
	lines.push("  - type: table");
	lines.push(`    name: ${yq("All elements")}`);
	lines.push(...order(["file.name", "formula.element_type", "note.supertype", "note.subtype"]));

	for (const [category, fields] of Object.entries(input.schema)) {
		const folder = `${elements}/${category}`;
		const filter = [
			"    filters:",
			"      or:",
			`        - ${ysq(`file.inFolder(${lit(folder)})`)}`,
			`        - ${ysq(`file.folder.startsWith(${lit(`${folder} (`)})`)}`,
		];
		const base = ["file.name", "note.supertype", "note.subtype"];
		const name = plural(category);

		lines.push("  - type: table");
		lines.push(`    name: ${yq(name)}`);
		lines.push(...filter);
		lines.push(...order([...base, ...(columnsByType.get(category) ?? []).map((k) => `note.${k}`)]));

		lines.push("  - type: cards");
		lines.push(`    name: ${yq(`${name} (cards)`)}`);
		lines.push(...filter);
		lines.push(...order(base));
		if ("image_url" in fields) lines.push("    image: note.image_url");
	}

	const rest = lines.join("\n") + "\n";
	return `${MARKER_TEXT} owb-bases:${FORMAT_VERSION}:${hash(rest)}\n${rest}`;
}

/**
 * True when `existing` is a Bases file this plugin wrote and nobody has changed
 * since: its marker line is there and the hash of the rest still matches.
 * Line endings do not count as a change (a sync tool may convert them).
 */
export function mayOverwriteBasesFile(existing: string): boolean {
	const text = normalizeEol(existing);
	const nl = text.indexOf("\n");
	if (nl < 0) return false;
	const m = MARKER_RE.exec(text.slice(0, nl));
	if (!m) return false;
	return hash(text.slice(nl + 1)) === m[2];
}

/** True when `existing` opens with the plugin's marker line, changed since or not. */
export function hasBasesMarker(existing: string): boolean {
	const text = normalizeEol(existing);
	const nl = text.indexOf("\n");
	return MARKER_RE.test(nl < 0 ? text : text.slice(0, nl));
}

/**
 * `existing` without the plugin's marker line (unchanged when it has none):
 * the user's copy of a base, which the plugin must never take for its own.
 */
export function stripBasesMarker(existing: string): string {
	const text = normalizeEol(existing);
	const nl = text.indexOf("\n");
	if (!MARKER_RE.test(nl < 0 ? text : text.slice(0, nl))) return existing;
	return nl < 0 ? "" : text.slice(nl + 1);
}
