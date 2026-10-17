/**
 * Draw relationships on a canvas (OW Infra #188, round 2, phase 2; build 6 of
 * the reach analysis): the active element's note, every element it links to
 * and (a setting, on by default) every element linking to it, as a JSON
 * Canvas 1.0 file beside the note, each edge labelled by its field.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import { DrawRelationshipsCommand } from "../Commands/DrawRelationshipsCommand";
import {
	buildRelationshipCanvas,
	canvasMarkerId,
	canvasStatus,
	isPluginCanvasFor,
	type CanvasData,
	type RelationshipGraph,
} from "../vault/relationship-canvas";
import { DEFAULT_SETTINGS } from "../settings/settings";

const W = "OnlyWorlds/Worlds/Hyperion/Elements";
const KASSAD = `${W}/Character/Kassad.md`;
const MONETA = `${W}/Character/Moneta.md`;
const KEATS = `${W}/Location/Keats.md`;
const BLADE = `${W}/Object/Blade.md`;
const FARCASTER = `${W}/Object/Farcaster.md`;
const RELATION = `${W}/Relation/Kassad and Moneta.md`;
const KASSAD_ID = "0199c000-0000-7000-8000-0000000000c1";
const DANGLING = "0199c000-0000-7000-8000-00000000dead";
const CANVAS = `${W}/Character/Kassad — relationships.canvas`;

type MockApp = ReturnType<typeof makeApp>;

/** A Character linking a Location and two Objects, a uuid with no note, a Character linking back, a Relation. */
async function seedWorld(vault: MockApp["vault"]): Promise<void> {
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	await vault.seed(
		KASSAD,
		`---\nid: ${KASSAD_ID}\nname: Kassad\nlocation: "[[Keats]]"\nobjects:\n  - "[[Blade]]"\n  - "[[Farcaster]]"\nrivals:\n  - ${DANGLING}\n---\n`
	);
	await vault.seed(MONETA, `---\nid: 0199c000-0000-7000-8000-0000000000c2\nname: Moneta\nfriends:\n  - "[[Kassad]]"\n---\n`);
	await vault.seed(`${W}/Character/Lamia.md`, `---\nid: 0199c000-0000-7000-8000-0000000000c3\nname: Lamia\nlocation: "[[Keats]]"\n---\n`);
	await vault.seed(KEATS, `---\nid: 0199c000-0000-7000-8000-0000000000a1\nname: Keats\n---\n`);
	await vault.seed(BLADE, `---\nid: 0199c000-0000-7000-8000-0000000000b1\nname: Blade\n---\n`);
	await vault.seed(FARCASTER, `---\nid: 0199c000-0000-7000-8000-0000000000b2\nname: Farcaster\n---\n`);
	await vault.seed(
		RELATION,
		`---\nid: 0199c000-0000-7000-8000-0000000000e1\nname: Kassad and Moneta\nactor: "[[Kassad]]"\ncharacters:\n  - "[[Moneta]]"\n---\n`
	);
}

function focus(app: MockApp["app"], vault: MockApp["vault"], path: string): void {
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () => vault.files.get(path)?.file ?? null;
}

async function draw(app: MockApp["app"], incoming = true): Promise<void> {
	await new DrawRelationshipsCommand(app, () => incoming).execute();
}

function canvasAt(vault: MockApp["vault"], path = CANVAS): CanvasData {
	const text = vault.contentAt(path);
	assert.ok(text, `no canvas at ${path}`);
	return JSON.parse(text) as CanvasData;
}

const NODE_KEYS: Record<string, string[]> = {
	text: ["text"],
	file: ["file", "subpath"],
	link: ["url"],
	group: ["label", "background", "backgroundStyle"],
};
const EDGE_KEYS = ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"];
const SIDES = ["top", "right", "bottom", "left"];

/** JSON Canvas 1.0's shape: only its keys, ids unique, every edge's ends exist. */
function assertSpecShape(c: CanvasData): void {
	assert.deepEqual(Object.keys(c).sort(), ["edges", "nodes"]);
	const ids = new Set<string>();
	for (const n of c.nodes as unknown as Array<Record<string, unknown>>) {
		assert.equal(typeof n.id, "string");
		assert.ok(!ids.has(n.id as string), `duplicate node id ${n.id}`);
		ids.add(n.id as string);
		assert.ok(String(n.type) in NODE_KEYS, `node type ${n.type}`);
		for (const k of ["x", "y", "width", "height"]) assert.ok(Number.isInteger(n[k]), `${n.id}.${k} is ${n[k]}`);
		const allowed = new Set(["id", "type", "x", "y", "width", "height", "color", ...NODE_KEYS[String(n.type)]]);
		for (const k of Object.keys(n)) assert.ok(allowed.has(k), `node key ${k}`);
		if (n.type === "file") assert.equal(typeof n.file, "string");
		if (n.type === "text") assert.equal(typeof n.text, "string");
	}
	const edgeIds = new Set<string>();
	for (const e of c.edges as unknown as Array<Record<string, unknown>>) {
		assert.ok(!edgeIds.has(e.id as string) && !ids.has(e.id as string), `duplicate edge id ${e.id}`);
		edgeIds.add(e.id as string);
		for (const k of Object.keys(e)) assert.ok(EDGE_KEYS.includes(k), `edge key ${k}`);
		assert.ok(ids.has(e.fromNode as string), `edge ${e.id} from a missing node`);
		assert.ok(ids.has(e.toNode as string), `edge ${e.id} to a missing node`);
		if (e.fromSide !== undefined) assert.ok(SIDES.includes(e.fromSide as string));
		if (e.toSide !== undefined) assert.ok(SIDES.includes(e.toSide as string));
	}
}

/** "from -> to : label", by file name or text, for the drawing's edges. */
function edgeList(c: CanvasData): string[] {
	const name = (id: string) => {
		const n = c.nodes.find((x) => x.id === id)!;
		return n.type === "file" ? n.file.split("/").pop()!.replace(/\.md$/, "") : n.text;
	};
	return c.edges.map((e) => `${name(e.fromNode)} -> ${name(e.toNode)} : ${e.label}`).sort();
}

function overlaps(c: CanvasData): string[] {
	const out: string[] = [];
	for (let i = 0; i < c.nodes.length; i++) {
		for (let j = i + 1; j < c.nodes.length; j++) {
			const a = c.nodes[i];
			const b = c.nodes[j];
			if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) out.push(`${a.id}/${b.id}`);
		}
	}
	return out;
}

test("the setting for links to the element is on by default", () => {
	assert.equal(DEFAULT_SETTINGS.canvasIncomingLinks, true);
});

test("Draw relationships: the element, what it links to, what links to it, a Relation through its own node, an unresolved uuid as text", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, KASSAD);
	await draw(app);
	const c = canvasAt(vault);
	assertSpecShape(c);

	assert.deepEqual(edgeList(c), [
		`Kassad -> Blade : objects`,
		`Kassad -> Farcaster : objects`,
		`Kassad -> Keats : location`,
		`Kassad -> No note for ${DANGLING} : rivals`,
		`Kassad and Moneta -> Kassad : actor`,
		`Kassad and Moneta -> Moneta : characters`,
		`Moneta -> Kassad : friends`,
	]);
	const files = c.nodes.filter((n) => n.type === "file").map((n) => n.file).sort();
	assert.deepEqual(files, [BLADE, FARCASTER, KASSAD, MONETA, KEATS, RELATION].sort(), "one file node per element, Lamia not drawn");
	assert.ok(c.nodes.some((n) => n.type === "text" && n.text.includes(DANGLING)), "the dangling uuid is a text node");
	assert.ok(c.nodes.some((n) => n.id.startsWith(canvasMarkerId(KASSAD_ID) + "-") && n.type === "text"), "the plugin's marker node, with its hash");

	// Outgoing on the right of the centre, incoming on the left.
	const centreX = (p: string) => {
		const n = c.nodes.find((x) => x.type === "file" && x.file === p)!;
		return n.x + n.width / 2;
	};
	const k = centreX(KASSAD);
	for (const p of [KEATS, BLADE, FARCASTER]) assert.ok(centreX(p) > k, `${p} right of the centre`);
	for (const p of [MONETA, RELATION]) assert.ok(centreX(p) < k, `${p} left of the centre`);
	assert.deepEqual(overlaps(c), []);
	assert.ok(__notices.some((n) => n.includes("Kassad — relationships.canvas")), __notices.join(" / "));
	assert.deepEqual((app as unknown as { opened: string[] }).opened, [CANVAS], "the canvas opens");
});

test("with the setting off, only what the element links to", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, KASSAD);
	await draw(app, false);
	const c = canvasAt(vault);
	assertSpecShape(c);
	assert.deepEqual(edgeList(c), [
		`Kassad -> Blade : objects`,
		`Kassad -> Farcaster : objects`,
		`Kassad -> Keats : location`,
		`Kassad -> No note for ${DANGLING} : rivals`,
	]);
});

test("a canvas name someone else holds gets a twin name; running it again overwrites the plugin's own, no third file", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	const theirs = JSON.stringify({ nodes: [{ id: "x", type: "text", text: "mine", x: 0, y: 0, width: 10, height: 10 }], edges: [] });
	await vault.seed(CANVAS, theirs);
	focus(app, vault, KASSAD);
	await draw(app);
	const twin = `${W}/Character/Kassad — relationships (1).canvas`;
	assert.equal(vault.contentAt(CANVAS), theirs, "the user's canvas is untouched");
	const first = canvasAt(vault, twin);
	assert.ok(isPluginCanvasFor(vault.contentAt(twin)!, KASSAD_ID));

	// A new link, then run again: the plugin's own file is redrawn in place.
	const note = vault.contentAt(KASSAD)!.replace("rivals:", 'birthplace: "[[Keats]]"\nrivals:');
	await vault.modify(vault.files.get(KASSAD)!.file, note);
	await draw(app);
	const canvases = [...vault.files.keys()].filter((p) => p.endsWith(".canvas")).sort();
	assert.deepEqual(canvases, [CANVAS, twin].sort());
	const second = canvasAt(vault, twin);
	assert.equal(second.edges.length, first.edges.length + 1);
	assert.ok(edgeList(second).includes("Kassad -> Keats : birthplace"));
	assert.equal(second.nodes.length, first.nodes.length, "Keats is one node with two edges");
});

test("a note that is not an element: a Notice, no canvas", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, "OnlyWorlds/Worlds/Hyperion/World.md");
	__notices.length = 0;
	await draw(app);
	assert.equal([...vault.files.keys()].some((p) => p.endsWith(".canvas")), false);
	assert.ok(__notices.some((n) => n.startsWith("Open an element's note")), __notices.join(" / "));
});

test("the layout keeps 24 links out, 24 in and a Relation's far side apart: no two nodes overlap", () => {
	const ref = (p: string) => ({ kind: "file" as const, path: p });
	const g: RelationshipGraph = {
		elementId: "id",
		elementName: "Hub",
		centre: "Hub.md",
		outgoing: Array.from({ length: 24 }, (_, i) => ({ field: `out_${i % 3}`, to: ref(`Out ${i}.md`) })),
		incoming: Array.from({ length: 24 }, (_, i) => ({ field: "friends", from: ref(`In ${i}.md`) })),
		through: Array.from({ length: 10 }, (_, i) => ({ relation: `In ${i % 2}.md`, field: "characters", to: ref(`Far ${i}.md`) })),
	};
	const c = buildRelationshipCanvas(g);
	assertSpecShape(c);
	assert.equal(c.nodes.length, 1 + 24 + 24 + 10 + 1);
	assert.equal(c.edges.length, 24 + 24 + 10);
	assert.deepEqual(overlaps(c), []);
	for (const e of c.edges) assert.match(e.label!, /^(out_\d|friends|characters)$/);
});

// ── Round 3, item 2: a canvas the user changed is theirs ──

const COPY = `${W}/Character/Kassad — relationships (your copy).canvas`;

test("a redraw of a canvas the user changed saves theirs first as (your copy), then draws fresh, and says both", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, KASSAD);
	await draw(app);
	const fresh = vault.contentAt(CANVAS)!;
	assert.equal(canvasStatus(fresh, KASSAD_ID), "unchanged");

	// The user moves a card and adds one of their own; the caption stays.
	const mine = JSON.parse(fresh) as CanvasData;
	mine.nodes[1].x += 100;
	mine.nodes.push({ id: "mine", type: "text", text: "my note", x: 5000, y: 5000, width: 200, height: 60 });
	const edited = JSON.stringify(mine, null, "	");
	await vault.modify(vault.files.get(CANVAS)!.file, edited);
	assert.equal(canvasStatus(edited, KASSAD_ID), "changed");

	__notices.length = 0;
	await draw(app);
	assert.equal(vault.contentAt(CANVAS), fresh, "redrawn fresh");
	const copy = JSON.parse(vault.contentAt(COPY)!) as CanvasData;
	assert.ok(copy.nodes.some((n) => n.id === "mine"), "the user's card is in the copy");
	assert.equal(copy.nodes[1].x, mine.nodes[1].x, "and their layout");
	assert.equal(canvasStatus(vault.contentAt(COPY)!, KASSAD_ID), "none", "the copy carries no marker: never the plugin's");
	assert.ok(
		__notices.some((n) => n.includes("Kassad — relationships (your copy).canvas") && n.includes("Kassad — relationships.canvas")),
		__notices.join(" / ")
	);

	await draw(app); // unchanged now: overwritten, no second copy
	assert.deepEqual([...vault.files.keys()].filter((p) => p.endsWith(".canvas")).sort(), [COPY, CANVAS].sort());
});

test("keys a viewer adds that the plugin never writes (and default arrow ends) do not count as a change", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, KASSAD);
	await draw(app);
	const c = JSON.parse(vault.contentAt(CANVAS)!) as unknown as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
	c.nodes[0].styleAttributes = {};
	c.edges[0].toEnd = "arrow";
	assert.equal(canvasStatus(JSON.stringify(c), KASSAD_ID), "unchanged");
	c.edges[0].label = "home";
	assert.equal(canvasStatus(JSON.stringify(c), KASSAD_ID), "changed");
});

// ── Round 3, item 3: a renamed element's old canvas ──

test("after the element is renamed, the new canvas is drawn under the new name and the Notice names the old one, left as is", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault);
	focus(app, vault, KASSAD);
	await draw(app);
	const old = vault.contentAt(CANVAS);
	await vault.modify(vault.files.get(KASSAD)!.file, vault.contentAt(KASSAD)!.replace("name: Kassad", "name: Fedmahn"));
	__notices.length = 0;
	await draw(app);
	assert.ok(vault.contentAt(`${W}/Character/Fedmahn — relationships.canvas`));
	assert.equal(vault.contentAt(CANVAS), old, "the old canvas is left as is");
	assert.ok(
		__notices.some((n) => n.includes("Fedmahn — relationships.canvas") && n.includes("Kassad — relationships.canvas")),
		__notices.join(" / ")
	);
});
