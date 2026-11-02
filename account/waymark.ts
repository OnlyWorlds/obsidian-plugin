import { OwAddressError, elementAddress, parseOwLink } from '@onlyworlds/sdk';

/**
 * The address of an element, and the way back from one: the pure half of the two address
 * commands (Commands/WaymarkCommands.ts). Nothing here touches Obsidian or the network, so
 * the test build compiles it. The spellings are the SDK's (one profile, written and read
 * by `elementAddress` and `parseOwLink`), never this file's own.
 */

/** What a user reads when the note's world has no key of its own and the vault holds more than one world. */
export const WORLD_NOT_TELLABLE = "This note's world has no key of its own, and this vault holds more than one world, so the plugin cannot tell which world the key in Settings opens. Add the world's key to its World.md, then try again.";

/**
 * May the key that was found be used to read this note's world id? Its own World.md key always;
 * the key in Settings only when the vault holds a single world (with two, it could be the other's).
 */
export function keyFitsWorld(resolved: { ownWorld: boolean }, worldsInVault: number): boolean {
	return resolved.ownWorld || worldsInVault <= 1;
}

/** What a user reads when a note has no element id yet. */
export const NOT_AN_ELEMENT = 'This note has no OnlyWorlds id yet. Save it once, then try again.';

/** A world that lives only in this vault has no page on the site. */
export const LOCAL_HAS_NO_PAGE = 'This world lives only in this vault, so it has no page on onlyworlds.com.';

/** The text is not an address of ours. */
export const NOT_AN_ADDRESS = 'That is not an OnlyWorlds address.';

/** The address names a whole world or a lens or moment of one, not a single element. */
export const NOT_ONE_ELEMENT = 'That address is not for one element.';

/** The element is not in this vault. */
export function noNoteFor(type: string): string {
	return `No note in this vault holds that ${type}.`;
}

/** The site's page for an element: the address profile's human form, from the world's id and the note's own. */
export function siteAddressOf(worldId: string, folderType: string, elementId: string): string {
	return elementAddress({ form: 'human', world: worldId, type: folderType.trim().toLowerCase(), id: elementId });
}

/** The element id a note's frontmatter holds, or null (no id yet, or not a string). */
export function noteIdOf(frontmatter: Record<string, unknown> | null | undefined): string | null {
	const id = frontmatter?.id;
	return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export type ReadAddress = { ok: true; type: string; id: string } | { ok: false; reason: string };

/**
 * One pasted address (either form: the site's page or the `ow://` text), read whole by the SDK.
 * A world's own address, or one that reads through a lens or at a moment, is not one element's.
 */
export function readAddress(text: string): ReadAddress {
	let reading;
	try {
		reading = parseOwLink(text);
	} catch (e) {
		if (e instanceof OwAddressError) return { ok: false, reason: NOT_AN_ADDRESS };
		throw e;
	}
	if (!reading.type || !reading.id || reading.lens || reading.moment !== null) {
		return { ok: false, reason: NOT_ONE_ELEMENT };
	}
	return { ok: true, type: reading.type, id: reading.id };
}

export interface AddressedNote {
	path: string;
	/** The type its folder holds, as the folder is named (`Character`). */
	type: string;
	id: string;
}

/** The note that holds the element: by id, and of that type (an id alone is one element, the type guards a stray copy). */
export function pickNote(notes: AddressedNote[], wanted: { type: string; id: string }): AddressedNote | null {
	const type = wanted.type.toLowerCase();
	const id = wanted.id.toLowerCase();
	return notes.find((n) => n.id.toLowerCase() === id && n.type.trim().toLowerCase() === type) ?? null;
}
