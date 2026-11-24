/**
 * The four-notes vault: notes a person put where the plugin does not write them,
 * the cases the Markdown profile's rulings name (a note is an element by its id
 * and type wherever it sits; the folder decides the type; a note with no id is
 * the person's own). The same cases the four-notes walk seeds in a real
 * Obsidian, plus one element note outside `Elements/` altogether.
 *
 *   a. an element note with an id and `type: location` in a folder that is no
 *      type's, inside the world (Akragas), and the same outside every world
 *      (never read);
 *   b. a note in `Character/` whose `type` says location: the folder decides,
 *      it is a Character (Misfiled);
 *   c. a note with `type: npc` and no id, in `Character/` and outside the
 *      world: the person's own, never read as an element;
 *   e. an element note with an id and `type: character` outside `Elements/`,
 *      in a folder of the person's own (Kolyan);
 *   plus Ireena in her type folder, the control.
 *
 * `body` lets a test give every element note the body it needs (a frontmatter
 * note of today's format by default).
 */
import type { MockVault } from "./obsidian-mock";

export const W = "OnlyWorlds/Worlds/W";
export const E = `${W}/Elements`;

export const IREENA = "019b0000-0000-7000-8000-0000000000a1";
export const AKRAGAS = "019b0000-0000-7000-8000-0000000000a2";
export const OUTSIDE = "019b0000-0000-7000-8000-0000000000a3";
export const MISFILED = "019b0000-0000-7000-8000-0000000000a4";
export const KOLYAN = "019b0000-0000-7000-8000-0000000000a5";

export const PATHS = {
	ireena: `${E}/Character/Ireena.md`,
	akragas: `${E}/Places/Akragas.md`,
	outside: "Places/Akragas outside.md",
	misfiled: `${E}/Character/Misfiled.md`,
	npcOne: `${E}/Character/Npc one.md`,
	npcTwo: "Notes/Npc two.md",
	kolyan: `${W}/Cast/Kolyan.md`,
};

/** A note: its front matter keys in order, then the body. */
export function note(fm: Record<string, string>, body: string): string {
	return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}`;
}

const section = (text: string) => `### Description\n\n${text}\n`;

/** Seed the world and its notes. */
export async function seedFourNotes(vault: MockVault, body: (text: string) => string = section): Promise<void> {
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	await vault.seed(PATHS.ireena, note({ name: "Ireena", id: IREENA }, body("A noble.")));
	await vault.seed(PATHS.akragas, note({ id: AKRAGAS, name: "Akragas", type: "location" }, body("A hill town.")));
	await vault.seed(PATHS.outside, note({ id: OUTSIDE, name: "Akragas outside", type: "location" }, body("Outside any world.")));
	await vault.seed(PATHS.misfiled, note({ id: MISFILED, name: "Misfiled", type: "location" }, body("A note in Character/ that says location.")));
	await vault.seed(PATHS.npcOne, note({ name: "Npc one", type: "npc" }, body("No id, in Character/.")));
	await vault.seed(PATHS.npcTwo, note({ name: "Npc two", type: "npc" }, body("No id, outside the world.")));
	await vault.seed(PATHS.kolyan, note({ name: "Kolyan", id: KOLYAN, type: "character" }, body("Outside Elements/.")));
}
