import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import { parseElementPath } from "../vault/element-file";
import { gatherRelationshipGraph } from "../vault/relationship-graph";
import { buildRelationshipCanvas, canvasStatus, withoutCanvasMarker } from "../vault/relationship-canvas";

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

	async execute(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md" || !parseElementPath(file.path)) {
			new Notice("Open an element's note first, then run Draw relationships on a canvas.");
			return;
		}
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
			if (existing && canvasStatus(await this.app.vault.read(existing), graph.elementId) === "changed") {
				copy = await this.freePath(folder, `${base} (your copy)`);
				await this.app.vault.create(copy, withoutCanvasMarker(await this.app.vault.read(existing), graph.elementId));
			}
			const canvas = existing ?? (await this.app.vault.create(path, text));
			if (existing) await this.app.vault.modify(existing, text);
			const links = graph.outgoing.length + graph.incoming.length;
			const name = path.split("/").pop();
			new Notice(
				copy
					? `${name} had your changes, so they were saved as ${copy.split("/").pop()}; ${name} is redrawn fresh (${links} link${links === 1 ? "" : "s"}).`
					: `${links} link${links === 1 ? "" : "s"} drawn: ${name}`,
				copy ? 12000 : undefined
			);
			await this.app.workspace.getLeaf(true).openFile(canvas);
		} catch (error) {
			console.error("OnlyWorlds: could not draw the relationships canvas", error);
			new Notice(`Could not draw the canvas: ${error instanceof Error ? error.message : String(error)}`, 8000);
		}
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
			if (taken instanceof TFile && canvasStatus(await this.app.vault.read(taken), elementId) !== "none") {
				return { path: taken.path, existing: taken };
			}
		}
		throw new Error(`no free name for ${base}.canvas`);
	}
}
