/**
 * Authentic old-format span-note MINTER (R9).
 *
 * Reproduces the EXACT pre-Phase-B write path so migration tests run against
 * writer-produced fixtures, not hand-written approximations:
 *
 *   1. the real `handlebars` library (the plugin's own dependency),
 *   2. the verbatim upstream Handlebars templates the plugin fetched from GitHub
 *      and rendered (`OnlyWorlds/OnlyWorlds/languages/obsidian_handlebars/*`),
 *   3. the `linkify` / `formatArray` helpers copied verbatim from main.ts
 *      (registerHandlebarsHelpers), which emit `[[id]]` tokens,
 *   4. DownloadWorldCommand's `linkifyContent` rewrite `[[id]] -> [[Name]]`
 *      (name form, sanitized) — so the on-disk note carries [[Name]] wikilinks,
 *      exactly as a downloaded old note did.
 *
 * `escape: false` (default) matches the `noEscape:true` compile the plugin used
 * post-2.2.2. `escape: true` reproduces the PRE-2.2.2 writer that HTML-escaped
 * field values (the `&#x27;` apostrophe class) — used to prove the migration
 * decodes entities.
 *
 * DISCLOSURE: the Handlebars template STRINGS are transcribed from the upstream
 * templates (verbatim, provided by the repo recon), not fetched live at test
 * time (the fetch hits GitHub and Obsidian's vault). The RENDER is genuine: real
 * handlebars, real helpers, real link-rewrite. So fixtures are writer-minted
 * through the real engine; only the template source is checked-in rather than
 * network-fetched.
 */
import Handlebars from "handlebars";

// --- helpers, verbatim from main.ts registerHandlebarsHelpers ----------------
const toId = (v: unknown): string | null => {
	if (v == null) return null;
	if (typeof v === "string") return v.trim();
	if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
		const id = (v as Record<string, unknown>).id;
		return typeof id === "string" ? id.trim() : null;
	}
	return null;
};

Handlebars.registerHelper("linkify", (ids: unknown) => {
	if (!ids) return "";
	if (Array.isArray(ids)) {
		return ids
			.map(toId)
			.filter((id): id is string => !!id)
			.map((id) => `[[${id}]]`)
			.join(", ");
	}
	if (typeof ids === "object") {
		const id = toId(ids);
		return id ? `[[${id}]]` : "";
	}
	return String(ids)
		.split(",")
		.map((id) => id.trim())
		.filter((id) => !!id)
		.map((id) => `[[${id}]]`)
		.join(", ");
});

// --- sanitizeFileName, verbatim from Scripts/WorldService --------------------
// (the wikilink target form: illegal filename chars -> '-')
export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-");
}

// --- verbatim upstream templates (transcribed; see DISCLOSURE) ---------------
export const CHARACTER_TEMPLATE = `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: {{name}}
- <span class="text-field" data-tooltip="Text">Description</span>: {{description}}
- <span class="text-field" data-tooltip="Text">Supertype</span>: {{supertype}}
- <span class="text-field" data-tooltip="Text">Subtype</span>: {{subtype}}

## Constitution
- <span class="string" data-tooltip="Text">Physicality</span>: {{physicality}}
- <span class="multi-link-field" data-tooltip="Multi Species">Species</span>: {{linkify species}}
- <span class="multi-link-field" data-tooltip="Multi Trait">Traits</span>: {{linkify traits}}
- <span class="integer" data-tooltip="Number">Height</span>: {{height}}

## Origins
- <span class="link-field" data-tooltip="Single Location">Birthplace</span>: {{linkify birthplace}}

## World
- <span class="link-field" data-tooltip="Single Location">Location</span>: {{linkify location}}
- <span class="multi-link-field" data-tooltip="Multi Object">Objects</span>: {{linkify objects}}

## Social
- <span class="multi-link-field" data-tooltip="Multi Family">Family</span>: {{linkify family}}

## Ttrpg
- <span class="integer" data-tooltip="Number">Str</span>: {{str}}

- <span class="text-field" data-tooltip="Text">Id</span>: {{id}}
- <span class="text-field" data-tooltip="Text">Image url</span>: {{image_url}}
`;

export const NARRATIVE_TEMPLATE = `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: {{name}}
- <span class="text-field" data-tooltip="Text">Description</span>: {{description}}
- <span class="text-field" data-tooltip="Text">Supertype</span>: {{supertype}}
- <span class="text-field" data-tooltip="Text">Story</span>: {{story}}

## Involves
- <span class="multi-link-field" data-tooltip="Multi Character">Characters</span>: {{linkify characters}}

- <span class="text-field" data-tooltip="Text">Id</span>: {{id}}
- <span class="text-field" data-tooltip="Text">Image url</span>: {{image_url}}
`;

const TEMPLATES: Record<string, string> = {
	character: CHARACTER_TEMPLATE,
	narrative: NARRATIVE_TEMPLATE,
};

/**
 * Mint an authentic old-format span note. `nameIndex` maps element id -> display
 * name (for the [[id]] -> [[Name]] rewrite, exactly as linkifyContent does).
 */
export function mintSpanNote(
	category: string,
	element: Record<string, unknown>,
	nameIndex: Record<string, string>,
	opts: { escape?: boolean } = {}
): string {
	const templateText = TEMPLATES[category.toLowerCase()];
	if (!templateText) throw new Error(`No mint template for ${category}`);
	const template = Handlebars.compile(templateText, { noEscape: !opts.escape });
	let note = template(element);

	// linkifyContent: [[id]] -> [[sanitize(Name)]] (name form on disk); an id with
	// no known name stays as [[id]] (identity preserved).
	note = note.replace(/\[\[(.*?)\]\]/g, (_m, id) => {
		const name = nameIndex[id];
		return name ? `[[${sanitizeFileName(name)}]]` : `[[${id}]]`;
	});
	return note;
}
