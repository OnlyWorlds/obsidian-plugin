/**
 * One element's relationships as a JSON Canvas 1.0 file (OW Infra #188, round
 * 2, phase 2) — PURE logic, no Obsidian imports. The Obsidian-facing half,
 * which reads the world and resolves the links, is vault/relationship-graph.ts.
 *
 * JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/): a top level of `nodes`
 * and `edges` only; a node is `id`, `type` (text, file, link, group), integer
 * `x`, `y`, `width`, `height`, optional `color`, plus its type's keys (a file
 * node's `file`, a text node's `text`); an edge is `id`, `fromNode`, `toNode`,
 * optional sides, ends, `color` and `label`. The spec names no place for a
 * tool's own data, so the plugin's mark is a text node: its `id` is
 * `owb-relationships-<element id>-<hash>`, its text a caption that says the
 * command redraws the canvas. The hash covers what the plugin drew: every
 * other node's and edge's own JSON Canvas keys, in id order, with one
 * substitution: a file node's path is hashed as the element id its note
 * names (the vault's, through `idOf`; else the node's own `el-<element id>`,
 * for a path no file holds any more while that element still has a note in
 * the world: a rename the canvas did not see). A card re-pointed to a note
 * of another element, to a file with no element id, or to a file outside the
 * world (another world's copy of the note included) is hashed so it counts as
 * the user's (round C, 6; Kael's delta read, low 2). So a rename of a note or its folders
 * (Rename World, a type folder's count, rename-on-save) changes no hash,
 * whether or not Obsidian rewrites the canvas's paths (Kael's seam read of
 * rc-350, low 2), while a card re-pointed to another note, moved, resized,
 * added or removed, or a label changed, makes the canvas the user's. A key
 * the plugin never writes (a viewer's own) and the spec's default arrow ends
 * do not count. The command redraws its own unchanged canvas in place, and saves
 * a changed one as `(your copy)` first (Kael's read of round 2, should-fix 2).
 *
 * The drawing: the element at the centre; the elements it links to on the
 * right half of a ring, those linking to it on the left (one node per
 * element, one edge per link, labelled by the field name); a Relation on the
 * ring keeps its own node, and its own links go out to a second ring; a link
 * with no note is a text node, so nothing is hidden.
 */

/** A file node's `id`: its element's id, so the drawing is named by elements, not paths. */
export type CanvasRef = { kind: "file"; path: string; id?: string } | { kind: "text"; text: string };

export interface RelationshipGraph {
	elementId: string;
	elementName: string;
	/** Vault path of the element's note (its id is `elementId`). */
	centre: string;
	/** The element's own links: field name -> what it names. */
	outgoing: Array<{ field: string; to: CanvasRef }>;
	/** Links to the element from other notes: field name on that note. */
	incoming: Array<{ field: string; from: CanvasRef }>;
	/** A Relation's own links, for a Relation on the ring (its note's path). */
	through: Array<{ relation: string; field: string; to: CanvasRef }>;
}

export type CanvasSide = "top" | "right" | "bottom" | "left";

interface NodeBase {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}
export type CanvasNode = (NodeBase & { type: "file"; file: string }) | (NodeBase & { type: "text"; text: string });

export interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide?: CanvasSide;
	toNode: string;
	toSide?: CanvasSide;
	label?: string;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

const NODE_W = 320;
const NODE_H = 120;
const CENTRE_W = 400;
const CENTRE_H = 200;
/** The least distance between two ring nodes' centres: a node's diagonal plus a margin. */
const REACH = Math.ceil(Math.hypot(NODE_W, NODE_H)) + 60;
const MIN_RADIUS = 650;

/** The marker node's id, before its hash: `owb-relationships-<element id>`. */
export function canvasMarkerId(elementId: string): string {
	return `owb-relationships-${elementId}`;
}

/** FNV-1a 32-bit, hex (as the Bases file's marker). */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

type Loose = Record<string, unknown>;
const v = (o: Loose, k: string, dflt: unknown = null): unknown => (o[k] === undefined ? dflt : o[k]);

/** The element id a note path names, or null (no note there, or no id). */
export type IdOfPath = (path: string) => string | null;

/**
 * What the hash asks the vault beyond `idOf`, for the canvas's world: what is
 * at a path ("none", a file not yet indexed, or one read), whether a path is
 * inside the world, and whether an element has a note in it.
 */
export interface CanvasVaultView {
	fileAt(path: string): "none" | "unread" | "read";
	inWorld(path: string): boolean;
	hasNoteInWorld(elementId: string): boolean;
}

/**
 * The hash of a drawing: every node but the marker, and every edge, by their
 * own JSON Canvas keys, in id order; a file node's `file` is hashed as the
 * element id its note names (see the header), never as the path.
 */
function drawingHash(nodes: Loose[], edges: Loose[], markerPrefix: string, idOf?: IdOfPath, vault?: CanvasVaultView): string {
	const byId = (a: Loose, b: Loose) => String(a.id).localeCompare(String(b.id));
	const element = (n: Loose): unknown => {
		if (typeof n.file !== "string") return v(n, "file");
		const at = vault?.fileAt(n.file);
		// A file outside the world is the user's, even one holding this
		// element's id (another world's copy of the note).
		if (vault && at === "read" && !vault.inWorld(n.file)) return n.file;
		const named = idOf?.(n.file);
		if (named) return named;
		const id = String(n.id);
		if (!id.startsWith("el-")) return n.file;
		// The node's own element stands in for a rename the canvas did not
		// see (no file at the path, the element's note still in the world)
		// and for a note not yet indexed. A read file with no id is the
		// user's; so is a path to nothing that no rename explains.
		const el = id.slice(3);
		if (at === "read") return n.file;
		if (at === "none" && vault && !vault.hasNoteInWorld(el)) return n.file;
		return el;
	};
	const ns = nodes
		.filter((n) => !String(n.id).startsWith(markerPrefix))
		.sort(byId)
		.map((n) =>
			["id", "type", "x", "y", "width", "height", "color", "file", "subpath", "text", "url", "label"].map((k) =>
				k === "file" ? element(n) : v(n, k)
			)
		);
	const es = [...edges]
		.sort(byId)
		.map((e) => [
			v(e, "id"),
			v(e, "fromNode"),
			v(e, "fromSide"),
			v(e, "fromEnd", "none"),
			v(e, "toNode"),
			v(e, "toSide"),
			v(e, "toEnd", "arrow"),
			v(e, "color"),
			v(e, "label"),
		]);
	return hash(JSON.stringify([ns, es]));
}

/**
 * Whose canvas `text` is, for the element `elementId`: "none" (no plugin
 * marker for it: someone else's, or not a canvas), "unchanged" (the plugin's,
 * as drawn), "changed" (the plugin's marker, but the drawing moved on: the
 * user's). `idOf` reads a note path's element id from the vault; `vault`
 * tells a rename from a card re-pointed (see the header).
 */
export function canvasStatus(
	text: string,
	elementId: string,
	idOf?: IdOfPath,
	vault?: CanvasVaultView
): "none" | "unchanged" | "changed" {
	let data: { nodes?: unknown; edges?: unknown };
	try {
		data = JSON.parse(text) as { nodes?: unknown; edges?: unknown };
	} catch {
		return "none";
	}
	const nodes = Array.isArray(data?.nodes) ? (data.nodes as Loose[]).filter((n) => n && typeof n === "object") : [];
	const edges = Array.isArray(data?.edges) ? (data.edges as Loose[]).filter((e) => e && typeof e === "object") : [];
	const prefix = canvasMarkerId(elementId) + "-";
	const marker = nodes.find((n) => typeof n.id === "string" && n.id.startsWith(prefix));
	if (!marker) return "none";
	return String(marker.id).slice(prefix.length) === drawingHash(nodes, edges, prefix, idOf, vault) ? "unchanged" : "changed";
}

/** True when `text` is a canvas this plugin drew for the element `elementId`, changed since or not. */
export function isPluginCanvasFor(text: string, elementId: string): boolean {
	return canvasStatus(text, elementId) !== "none";
}

/** `text` without the plugin's marker node for `elementId`: the user's copy, never taken for the plugin's. */
export function withoutCanvasMarker(text: string, elementId: string): string {
	const data = JSON.parse(text) as { nodes?: Loose[] };
	const prefix = canvasMarkerId(elementId) + "-";
	if (Array.isArray(data.nodes)) data.nodes = data.nodes.filter((n) => !(n && typeof n.id === "string" && n.id.startsWith(prefix)));
	return JSON.stringify(data, null, "\t");
}

function refKey(ref: CanvasRef): string {
	return ref.kind === "file" ? `f:${ref.path}` : `t:${ref.text}`;
}

/** Radius at which `count` nodes spread over `arc` radians sit REACH apart. */
function radiusFor(count: number, arc: number): number {
	if (count < 2) return 0;
	const step = arc / count;
	return REACH / (2 * Math.sin(Math.min(step, Math.PI) / 2));
}

/** The side of `a` facing `b`, by the larger of the two offsets. */
function sideToward(ax: number, ay: number, bx: number, by: number): CanvasSide {
	const dx = bx - ax;
	const dy = by - ay;
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
	return dy >= 0 ? "bottom" : "top";
}

export function buildRelationshipCanvas(g: RelationshipGraph): CanvasData {
	const centreKey = refKey({ kind: "file", path: g.centre });
	const refs = new Map<string, CanvasRef>();
	const right: string[] = [];
	const left: string[] = [];
	const placed = new Set<string>([centreKey]);
	refs.set(centreKey, { kind: "file", path: g.centre, id: g.elementId });
	const remember = (k: string, ref: CanvasRef) => {
		const had = refs.get(k);
		if (!had || (had.kind === "file" && !had.id)) refs.set(k, ref);
	};
	const place = (ref: CanvasRef, half: string[]) => {
		const k = refKey(ref);
		remember(k, ref);
		if (placed.has(k)) return;
		placed.add(k);
		half.push(k);
	};
	for (const l of g.outgoing) place(l.to, right);
	for (const l of g.incoming) place(l.from, left);
	const outer: Array<{ key: string; parent: string }> = [];
	for (const l of g.through) {
		const k = refKey(l.to);
		remember(k, l.to);
		if (placed.has(k)) continue;
		placed.add(k);
		outer.push({ key: k, parent: refKey({ kind: "file", path: l.relation }) });
	}

	// Centres of the nodes, the element at (0, 0); y grows downward.
	const at = new Map<string, { cx: number; cy: number; angle: number }>();
	at.set(centreKey, { cx: 0, cy: 0, angle: 0 });
	const r1 = Math.max(MIN_RADIUS, radiusFor(Math.max(right.length, left.length), Math.PI));
	const ring = (keys: string[], from: number) => {
		keys.forEach((k, i) => {
			const angle = from + (Math.PI * (i + 0.5)) / keys.length;
			at.set(k, { cx: r1 * Math.cos(angle), cy: r1 * Math.sin(angle), angle });
		});
	};
	ring(right, -Math.PI / 2);
	ring(left, Math.PI / 2);

	if (outer.length) {
		// The second ring: each node near its Relation's angle, REACH apart.
		const m = outer.length;
		let r2 = r1 + REACH + 100;
		let gap = 2 * Math.asin(Math.min(1, REACH / (2 * r2)));
		if (m * gap > 2 * Math.PI) {
			r2 = Math.max(r2, radiusFor(m, 2 * Math.PI));
			gap = (2 * Math.PI) / m;
		}
		const wanted = outer
			.map((o) => ({ key: o.key, angle: at.get(o.parent)?.angle ?? 0 }))
			.sort((a, b) => a.angle - b.angle);
		const angles: number[] = [];
		for (const w of wanted) angles.push(angles.length ? Math.max(w.angle, angles[angles.length - 1] + gap) : w.angle);
		if (angles[angles.length - 1] - angles[0] > 2 * Math.PI - gap) {
			for (let i = 0; i < m; i++) angles[i] = angles[0] + (i * 2 * Math.PI) / m;
		}
		wanted.forEach((w, i) => at.set(w.key, { cx: r2 * Math.cos(angles[i]), cy: r2 * Math.sin(angles[i]), angle: angles[i] }));
	}

	const ids = new Map<string, string>();
	const used = new Set<string>();
	const nodes: CanvasNode[] = [];
	const addNode = (k: string, ref: CanvasRef) => {
		const p = at.get(k)!;
		const w = k === centreKey ? CENTRE_W : NODE_W;
		const h = k === centreKey ? CENTRE_H : NODE_H;
		// A file node is named by its element; a text node (or two notes sharing an id) by its place.
		const own = ref.kind === "file" && ref.id ? `el-${ref.id}` : null;
		const id = own && !used.has(own) ? own : `n${nodes.length}`;
		used.add(id);
		ids.set(k, id);
		const box = { id, x: Math.round(p.cx - w / 2), y: Math.round(p.cy - h / 2), width: w, height: h };
		nodes.push(ref.kind === "file" ? { ...box, type: "file", file: ref.path } : { ...box, type: "text", text: ref.text });
	};
	addNode(centreKey, refs.get(centreKey)!);
	for (const k of [...right, ...left, ...outer.map((o) => o.key)]) addNode(k, refs.get(k)!);

	const edges: CanvasEdge[] = [];
	const seen = new Set<string>();
	const addEdge = (from: string, to: string, label: string) => {
		const a = ids.get(from);
		const b = ids.get(to);
		const key = `${from}\n${to}\n${label}`;
		if (!a || !b || a === b || seen.has(key)) return;
		seen.add(key);
		const pa = at.get(from)!;
		const pb = at.get(to)!;
		edges.push({
			id: `e${edges.length}`,
			fromNode: a,
			fromSide: sideToward(pa.cx, pa.cy, pb.cx, pb.cy),
			toNode: b,
			toSide: sideToward(pb.cx, pb.cy, pa.cx, pa.cy),
			label,
		});
	};
	for (const l of g.outgoing) addEdge(centreKey, refKey(l.to), l.field);
	for (const l of g.incoming) addEdge(refKey(l.from), centreKey, l.field);
	for (const l of g.through) addEdge(refKey({ kind: "file", path: l.relation }), refKey(l.to), l.field);

	// The plugin's mark: a caption below the drawing's lower-left corner.
	const minX = Math.min(...nodes.map((n) => n.x));
	const maxY = Math.max(...nodes.map((n) => n.y + n.height));
	const prefix = canvasMarkerId(g.elementId) + "-";
	const drawnIds = new Map<string, string>();
	for (const r of refs.values()) if (r.kind === "file" && r.id) drawnIds.set(r.path, r.id);
	const drawnIdOf: IdOfPath = (path) => drawnIds.get(path) ?? null;
	nodes.push({
		id: prefix + drawingHash(nodes as unknown as Loose[], edges as unknown as Loose[], prefix, drawnIdOf),
		type: "text",
		text:
			`Drawn by OnlyWorlds Builder from the links of ${g.elementName}. ` +
			"Run Draw relationships on a canvas on its note again to redraw it; changes made here are replaced.",
		x: minX,
		y: maxY + 160,
		width: 640,
		height: 100,
	});
	return { nodes, edges };
}
