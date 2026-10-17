import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import { parseElementPath } from "../vault/element-file";
import { gatherRelationshipGraph } from "../vault/relationship-graph";
import { buildRelationshipCanvas, canvasStatus, withoutCanvasMarker, type CanvasVaultView } from "../vault/relationship-canvas";

/**
 * Draw relationships on a canvas (OW Infra #188, round 2, phase 2): the active
 * element's note, what it links to and (the setting, on by default) what links
 * to it, as `<Element name> — relationships.canvas` beside the note, then
 * opens it. Running it again redraws the plugin's own canvas; one the user
 * changed since is first saved beside it as `<name> (your copy).canvas`; a
 * name someone else's file holds gets the next free `(N)`.
 */
export class DrawRelationshipsCommand {
	constructor(private app: App, private incoming: () => boolean) {}

	/** The element id the note at `path` carries, for the canvas marker's hash (null: no note, no id). */
	private idOf = (path: string): string | null => {
		const f = this.app.vault.getAbstractFileByPath(path);
		const id = f instanceof TFile ? this.app.metadataCache.getFileCache(f)?.frontmatter?.id : undefined;
		return typeof id === "string" ? id : null;
	};

	/** The world of the note being drawn: the canvas's world. */
	private world = "";

	/** What is at a path, inside the world or not, and whether an element has a note in it: a rename told from a card re-pointed (round C, 6). */
	private view: CanvasVaultView = {
		// A note Obsidian has not indexed yet is "unread", never taken as one
		// without an id: a cold cache keeps the card's own element.
		fileAt: (path) => {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return "none";
			return f.extension !== "md" || this.app.metadataCache.getFileCache(f) !== null ? "read" : "unread";
		},
		inWorld: (path) => path.startsWith(`OnlyWorlds/Worlds/${this.world}/`),
		hasNoteInWorld: (elementId) =>
			this.app.vault
				.getMarkdownFiles()
				.some((f) => this.view.inWorld(f.path) && this.app.metadataCache.getFileCache(f)?.frontmatter?.id === elementId),
	};

	async execute(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md" || !parseElementPath(file.path)) {
			new Notice("Open an element's note first, then run Draw relationships on a canvas.");
			return;
		}
		this.world = parseElementPath(file.path)?.worldName ?? "";
		try {
			const graph = await gatherRelationshipGraph(this.app, file, { incoming: this.incoming() });
			if (!graph) {
				new Notice(`${file.basename} has no element id in its Properties, so there is nothing to draw.`);
				return;
			}
			const text = JSON.stringify(buildRelationshipCanvas(graph), null, "\t");
			const folder = file.parent?.path ?? normalizePath(file.path.slice(0, file.path.lastIndexOf("/")));
			const base = sanitizeFileName(`${graph.elementName} — relationships`);
			const { path, existing } = await this.claimCanvasPath(folder, base, graph.elementId);
			let copy: string | null = null;
			if (existing && canvasStatus(await this.app.vault.read(existing), graph.elementId, this.idOf, this.view) === "changed") {
				copy = await this.freePath(folder, `${base} (your copy)`);
				await this.app.vault.create(copy, withoutCanvasMarker(await this.app.vault.read(existing), graph.elementId));
			}
			const canvas = existing ?? (await this.app.vault.create(path, text));
			if (existing) await this.app.vault.modify(existing, text);
			const links = graph.outgoing.length + graph.incoming.length;
			const name = path.split("/").pop();
			const earlier = await this.earlierCanvases(folder, path, graph.elementId);
			const left = earlier.length
				? ` Its canvas under an earlier name, ${earlier.join(", ")}, is left as is.`
				: "";
			new Notice(
				(copy
					? `${name} had your changes, so they were saved as ${copy.split("/").pop()}; ${name} is redrawn fresh (${links} link${links === 1 ? "" : "s"}).`
					: `${links} link${links === 1 ? "" : "s"} drawn: ${name}.`) + left,
				copy || left ? 12000 : undefined
			);
			await this.app.workspace.getLeaf(true).openFile(canvas);
		} catch (error) {
			console.error("OnlyWorlds: could not draw the relationships canvas", error);
			new Notice(`Could not draw the canvas: ${error instanceof Error ? error.message : String(error)}`, 8000);
		}
	}

	/**
	 * The plugin's other canvases for this element beside the note (drawn under
	 * a name the element had before): their names, for the Notice. Left as is.
	 */
	private async earlierCanvases(folder: string, drawn: string, elementId: string): Promise<string[]> {
		const parent = this.app.vault.getAbstractFileByPath(folder);
		if (!(parent instanceof TFolder)) return [];
		const out: string[] = [];
		for (const c of parent.children) {
			if (!(c instanceof TFile) || c.extension !== "canvas" || c.path === drawn) continue;
			if (canvasStatus(await this.app.vault.read(c), elementId, this.idOf, this.view) !== "none") out.push(c.name);
		}
		return out.sort();
	}

	/** `<base>.canvas`, or `<base> 2.canvas`, 3 and on: the first free name (the user's copy). */
	private async freePath(folder: string, base: string): Promise<string> {
		for (let n = 1; ; n++) {
			const path = normalizePath(`${folder}/${n === 1 ? base : `${base.replace(/\)$/, "")} ${n})`}.canvas`);
			if (!this.app.vault.getAbstractFileByPath(path) && !(await this.app.vault.adapter.exists(path))) return path;
		}
	}

	/**
	 * `<base>.canvas`, or the first `<base> (N).canvas`, that is free or is the
	 * plugin's own canvas for this element. Names compare case-insensitively,
	 * as Windows and macOS do (vault/element-file.ts's claimNotePath).
	 */
	private async claimCanvasPath(folder: string, base: string, elementId: string): Promise<{ path: string; existing: TFile | null }> {
		const siblings = new Map<string, TFile>();
		const parent = this.app.vault.getAbstractFileByPath(folder);
		if (parent instanceof TFolder) {
			for (const c of parent.children) if (c instanceof TFile) siblings.set(c.path.toLowerCase(), c);
		}
		for (let n = 0; n <= 1000; n++) {
			const path = normalizePath(`${folder}/${n === 0 ? base : `${base} (${n})`}.canvas`);
			const taken = siblings.get(path.toLowerCase()) ?? this.app.vault.getAbstractFileByPath(path);
			if (!taken) return { path, existing: null };
			if (taken instanceof TFile && canvasStatus(await this.app.vault.read(taken), elementId, this.idOf, this.view) !== "none") {
				return { path: taken.path, existing: taken };
			}
		}
		throw new Error(`no free name for ${base}.canvas`);
	}
}
