/**
 * World units — pure logic, NO Obsidian imports (unit-tested under `npm test`).
 *
 * The OnlyWorlds standard 00.31.00 added three free-text World fields:
 * `length_unit`, `mass_unit`, `distance_unit` (at most 64 characters, "" = not
 * set). They are LABELS for the numbers a world counts in; nothing converts.
 * The stored element value stays a plain number; the unit is shown beside it.
 *
 * The nine unit-bearing element fields are read off the standard's field
 * descriptions ("in the world's length unit (World length_unit)"), canonical
 * 00.31.00. FIELD_SCHEMA in @onlyworlds/sdk carries no unit metadata (4.7.2
 * neither), so the map lives here.
 */

export type UnitKind = "length" | "mass" | "distance";

export const WORLD_UNIT_FIELDS = ["length_unit", "mass_unit", "distance_unit"] as const;
export type WorldUnitField = (typeof WORLD_UNIT_FIELDS)[number];

/** Present keys only: an absent key means "not known here", "" means "not set". */
export type WorldUnits = Partial<Record<WorldUnitField, string>>;

/** The World.md line labels. toSnakeCase(label) is the field name. */
export const WORLD_UNIT_LABELS: Record<WorldUnitField, string> = {
	length_unit: "Length Unit",
	mass_unit: "Mass Unit",
	distance_unit: "Distance Unit",
};

const KIND_TO_FIELD: Record<UnitKind, WorldUnitField> = {
	length: "length_unit",
	mass: "mass_unit",
	distance: "distance_unit",
};

/** The nine unit-bearing element fields (category lowercase -> field -> kind). */
export const UNIT_BEARING_FIELDS: Readonly<Record<string, Readonly<Record<string, UnitKind>>>> = {
	ability: { range: "distance" },
	character: { height: "length", weight: "mass" },
	creature: { height: "length", weight: "mass", speed: "distance" },
	location: { elevation: "distance" },
	object: { weight: "mass" },
	species: { weight: "mass" },
};

/** The unit kind a field is counted in, or null when it carries none. */
export function unitKindFor(category: string, field: string): UnitKind | null {
	const cat = category.trim().toLowerCase();
	const fields = UNIT_BEARING_FIELDS[cat];
	if (!fields || !Object.prototype.hasOwnProperty.call(fields, field)) return null;
	return fields[field];
}

/** The world's unit label for a field, or "" when the field carries none or the world set none. */
export function unitFor(category: string, field: string, units: WorldUnits): string {
	const kind = unitKindFor(category, field);
	if (!kind) return "";
	const value = units[KIND_TO_FIELD[kind]];
	return typeof value === "string" ? value.trim() : "";
}

/**
 * A field's value as shown: "182 cm" when the field carries a unit and the world
 * set one, else the bare value as before. Empty values show as "" (no lone unit).
 */
export function formatWithUnit(category: string, field: string, value: unknown, units: WorldUnits): string {
	if (typeof value !== "number" && typeof value !== "string") return "";
	const shown = String(value);
	if (shown.trim() === "") return "";
	const unit = unitFor(category, field, units);
	return unit ? `${shown} ${unit}` : shown;
}

function lineRegex(field: WorldUnitField): RegExp {
	// Tolerant of a missing space after the colon (an editor may trim trailing
	// whitespace off "- **Length Unit:** "), so a cleared value still reads as "".
	return new RegExp(`^- \\*\\*${WORLD_UNIT_LABELS[field]}:\\*\\*[ \\t]*(.*?)[ \\t]*\\r?$`, "m");
}

/** The unit lines World.md carries. A line that is absent is absent here too. */
export function parseWorldUnits(worldMd: string): WorldUnits {
	const units: WorldUnits = {};
	for (const field of WORLD_UNIT_FIELDS) {
		const m = lineRegex(field).exec(worldMd);
		if (m) units[field] = m[1];
	}
	return units;
}

/** The unit fields a server world body carries (null reads as ""). Keys the body lacks stay absent. */
export function worldUnitsFromBody(body: Record<string, unknown> | null | undefined): WorldUnits {
	const units: WorldUnits = {};
	if (!body) return units;
	for (const field of WORLD_UNIT_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
		const v = body[field];
		units[field] = typeof v === "string" ? v : "";
	}
	return units;
}

/**
 * Write the given unit values into World.md content: an existing line is
 * replaced in place, a missing one is added under a `## Units` heading after
 * the last field line (prose below the field list, such as a local world's
 * how-to, stays below). Keys absent from `units` are left untouched.
 */
export function upsertWorldUnits(worldMd: string, units: WorldUnits): string {
	const eol = worldMd.includes("\r\n") ? "\r\n" : "\n";
	let out = worldMd;
	const missing: WorldUnitField[] = [];
	for (const field of WORLD_UNIT_FIELDS) {
		const value = units[field];
		if (value === undefined) continue;
		const re = lineRegex(field);
		const line = `- **${WORLD_UNIT_LABELS[field]}:** ${value}`;
		if (re.test(out)) {
			out = out.replace(re, (whole) => (whole.endsWith("\r") ? `${line}\r` : line));
		} else {
			missing.push(field);
		}
	}
	if (missing.length === 0) return out;

	const lines = out.split(eol);
	const hasUnitsHeading = lines.findIndex((l) => /^##\s*Units\s*$/.test(l));
	const newLines = missing.map((f) => `- **${WORLD_UNIT_LABELS[f]}:** ${units[f]}`);
	let insertAt: number;
	let block: string[];
	if (hasUnitsHeading >= 0) {
		insertAt = hasUnitsHeading + 1;
		while (insertAt < lines.length && /^- \*\*[^*]+:\*\*/.test(lines[insertAt])) insertAt++;
		block = newLines;
	} else {
		let lastField = -1;
		lines.forEach((l, i) => {
			if (/^- \*\*[^*]+:\*\*/.test(l)) lastField = i;
		});
		insertAt = lastField >= 0 ? lastField + 1 : lines.length;
		block = ["", "## Units", ...newLines];
	}
	lines.splice(insertAt, 0, ...block);
	return lines.join(eol);
}

/**
 * The world PATCH body an upload sends: each unit World.md carries whose value
 * differs from the server's. A key the server body lacks is never sent (an
 * older server 422s an unknown field). Values go as written in World.md; the
 * comparison ignores surrounding whitespace, which the server trims anyway.
 */
export function worldUnitsPatch(local: WorldUnits, serverBody: Record<string, unknown> | null | undefined): WorldUnits {
	const server = worldUnitsFromBody(serverBody);
	const patch: WorldUnits = {};
	for (const field of WORLD_UNIT_FIELDS) {
		const mine = local[field];
		const theirs = server[field];
		if (mine === undefined || theirs === undefined) continue;
		if (mine.trim() !== theirs.trim()) patch[field] = mine;
	}
	return patch;
}

/** The two world calls an upload needs (V2Client satisfies it; tests pass a fake). */
export interface WorldUnitsClient {
	getWorld(): Promise<Record<string, unknown>>;
	patchWorld(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Upload's world step: send the units World.md carries when they differ from
 * the server's. No unit lines in World.md (a world file from before 00.31.00)
 * means no call at all. PATCH /world is owner-only, so an unchanged unit is
 * never sent: a co-builder's upload only reaches the PATCH when they changed a
 * unit, and that 403 is the caller's to report. Returns what was sent.
 */
export async function pushWorldUnits(client: WorldUnitsClient, local: WorldUnits): Promise<WorldUnits> {
	if (!WORLD_UNIT_FIELDS.some((f) => local[f] !== undefined)) return {};
	const server = await client.getWorld();
	const patch = worldUnitsPatch(local, server);
	if (Object.keys(patch).length > 0) await client.patchWorld(patch);
	return patch;
}
