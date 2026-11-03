/**
 * The pure half of the two address commands: the address a note writes for the site (the SDK's profile,
 * never a spelling of ours), the one element a pasted address names, and the note that holds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OwAddressError, elementAddress } from "@onlyworlds/sdk";
import {
	NOT_AN_ADDRESS,
	NOT_ONE_ELEMENT,
	keyFitsWorld,
	noteIdOf,
	withScheme,
	pickNote,
	readAddress,
	siteAddressOf,
	type AddressedNote,
} from "../account/waymark";

const WORLD = "0695db52-5433-7332-8000-db7fe10da375";
const ELEMENT = "0695db83-afd7-76ee-8000-00f4295f8866";
const OTHER = "0695db83-afd7-76ee-8000-00f4295f8867";

test("a note's site address is the profile's human form, lowercase, from the world's id and the note's own", () => {
	assert.equal(
		siteAddressOf(WORLD, "Character", ELEMENT),
		`https://www.onlyworlds.com/w/${WORLD}/character/${ELEMENT}`,
	);
	assert.equal(siteAddressOf(WORLD, "Species", ELEMENT), elementAddress({ form: "human", world: WORLD, type: "species", id: ELEMENT }));
});

test("a world's slug is refused by the writer, not spelled by us", () => {
	assert.throws(() => siteAddressOf("moppetopia", "Character", ELEMENT), (e: unknown) => e instanceof OwAddressError && e.reason === "bad_world");
});

test("both spellings of an element's address read to one element, and the site's address reads back to its own note", () => {
	const human = readAddress(siteAddressOf(WORLD, "Character", ELEMENT));
	const text = readAddress(`ow://${WORLD}/character/${ELEMENT}`);
	assert.deepEqual(human, { ok: true, type: "character", id: ELEMENT });
	assert.deepEqual(text, { ok: true, type: "character", id: ELEMENT });
});

test("what is not one element's address is refused, each in its own words", () => {
	assert.deepEqual(readAddress("hello"), { ok: false, reason: NOT_AN_ADDRESS });
	assert.deepEqual(readAddress(""), { ok: false, reason: NOT_AN_ADDRESS });
	assert.deepEqual(readAddress(`https://example.com/w/${WORLD}/character/${ELEMENT}`), { ok: false, reason: NOT_AN_ADDRESS });
	// the world's own address, an element read through a lens, an element at a moment: real addresses, none of them one element's
	assert.deepEqual(readAddress(elementAddress({ form: "human", world: WORLD })), { ok: false, reason: NOT_ONE_ELEMENT });
	assert.deepEqual(readAddress(elementAddress({ form: "human", world: WORLD, type: "character", id: ELEMENT, lens: OTHER })), { ok: false, reason: NOT_ONE_ELEMENT });
	assert.deepEqual(readAddress(elementAddress({ form: "human", world: WORLD, type: "character", id: ELEMENT, moment: 5 })), { ok: false, reason: NOT_ONE_ELEMENT });
});

test("the note is found by its id and its type; a stray copy of the id in another type's folder is not it", () => {
	const notes: AddressedNote[] = [
		{ path: "OnlyWorlds/Worlds/W/Elements/Location/Moppet Town.md", type: "Location", id: ELEMENT },
		{ path: "OnlyWorlds/Worlds/W/Elements/Character/Fluffington.md", type: "Character", id: ELEMENT },
		{ path: "OnlyWorlds/Worlds/W/Elements/Character/Other.md", type: "Character", id: OTHER },
	];
	assert.equal(pickNote(notes, { type: "character", id: ELEMENT })?.path, "OnlyWorlds/Worlds/W/Elements/Character/Fluffington.md");
	assert.equal(pickNote(notes, { type: "location", id: ELEMENT })?.path, "OnlyWorlds/Worlds/W/Elements/Location/Moppet Town.md");
	assert.equal(pickNote(notes, { type: "species", id: ELEMENT }), null);
	assert.equal(pickNote(notes, { type: "character", id: "0695db83-afd7-76ee-8000-000000000000" }), null);
	assert.equal(pickNote([], { type: "character", id: ELEMENT }), null);
});

test("a note's id is its frontmatter's id when that is a non-empty string, and nothing else", () => {
	assert.equal(noteIdOf({ id: ELEMENT }), ELEMENT);
	assert.equal(noteIdOf({ id: `  ${ELEMENT} ` }), ELEMENT);
	assert.equal(noteIdOf({ id: "" }), null);
	assert.equal(noteIdOf({ id: 5 }), null);
	assert.equal(noteIdOf({}), null);
	assert.equal(noteIdOf(null), null);
	assert.equal(noteIdOf(undefined), null);
});

test("the key in Settings opens a note's world only when the vault holds one world; the world's own key always", () => {
	assert.equal(keyFitsWorld({ ownWorld: true }, 3), true);
	assert.equal(keyFitsWorld({ ownWorld: false }, 1), true);
	assert.equal(keyFitsWorld({ ownWorld: false }, 2), false, "two worlds: the Settings key could be the other world's");
});

test("a note whose id is written in capitals is still found by an address, which the SDK reads in lowercase", () => {
	const upper = ELEMENT.toUpperCase();
	const notes = [{ path: "OnlyWorlds/Worlds/W/Elements/Character/Fluffington.md", type: "Character", id: upper }];
	assert.equal(pickNote(notes, { type: "character", id: ELEMENT })?.path, notes[0].path);
});

test("a paste without its scheme gains https:// before the reader; http, other hosts and the account page still refuse", () => {
	const bare = `www.onlyworlds.com/w/${WORLD}/character/${ELEMENT}`;
	assert.deepEqual(readAddress(bare), { ok: true, type: "character", id: ELEMENT });
	assert.deepEqual(readAddress(`  ${bare}  `), { ok: true, type: "character", id: ELEMENT }, "padding is fine");
	assert.equal(withScheme(`ow://${WORLD}/character/${ELEMENT}`), `ow://${WORLD}/character/${ELEMENT}`, "an ow:// text is left as it is");
	assert.equal(readAddress(`http://www.onlyworlds.com/w/${WORLD}/character/${ELEMENT}`).ok, false, "http still refused");
	assert.equal(readAddress(`www.example.com/w/${WORLD}/character/${ELEMENT}`).ok, false, "another host still refused");
	// the Captain's paste, 11-03: the member's editing page, which the profile refuses by name and the reader does not learn
	assert.deepEqual(readAddress(`www.onlyworlds.com/account/worlds/${WORLD}/elements/character/${ELEMENT}`), { ok: false, reason: NOT_AN_ADDRESS });
	assert.deepEqual(readAddress(`https://www.onlyworlds.com/account/worlds/${WORLD}/elements/character/${ELEMENT}`), { ok: false, reason: NOT_AN_ADDRESS });
});

test("the refusal says what an address looks like, and that the browser bar's page address is not one", () => {
	assert.match(NOT_AN_ADDRESS, /onlyworlds\.com\/w\/<world>\/<type>\/<element>/);
	assert.match(NOT_AN_ADDRESS, /ow:\/\//);
	assert.match(NOT_AN_ADDRESS, /browser bar/);
	assert.match(NOT_AN_ADDRESS, /Open with.*Copy link/);
});
