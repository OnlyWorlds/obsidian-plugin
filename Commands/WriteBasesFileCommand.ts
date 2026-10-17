import { App, Notice, TFile, normalizePath } from "obsidian";
import { WorldService } from "../Scripts/WorldService";
import { basesFilePath, rebuildWorldBasesFile } from "../vault/bases-writer";

/**
 * Write Bases file (OW Infra #188): `<world>.base` beside World.md, a table and
 * a card view per element type in Obsidian's core Bases. The world is the one
 * the active note sits in, else the primary world (as Update Category Counts).
 * Run by hand, it rebuilds a base the user changed too, keeping their version
 * beside it (the way out Download's kept-file Notice names).
 */
export class WriteBasesFileCommand {
	private worldService: WorldService;

	constructor(private app: App) {
		this.worldService = new WorldService(app);
	}

	async execute(): Promise<void> {
		const folder = await this.targetWorld();
		if (!folder || !(this.app.vault.getAbstractFileByPath(normalizePath(`OnlyWorlds/Worlds/${folder}/World.md`)) instanceof TFile)) {
			new Notice("No world found: open a note inside a world, or create or download one first.");
			return;
		}
		const path = basesFilePath(folder);
		try {
			const { result, copy } = await rebuildWorldBasesFile(this.app, folder);
			if (result === "kept") {
				new Notice(`${path} is a folder, so no Bases file was written. Rename or move it, then run Write Bases file again.`, 10000);
			} else if (copy) {
				new Notice(`${path} was rebuilt. Your own version is kept beside it as ${copy.split("/").pop()}.`, 10000);
			} else if (result === "unchanged") {
				new Notice(`${path} is already up to date.`);
			} else {
				new Notice(`Bases file written: ${path}. It needs Obsidian 1.9 or later, with the Bases core plugin on.`, 8000);
			}
		} catch (error) {
			console.error("OnlyWorlds: could not write the Bases file", error);
			new Notice(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`, 8000);
		}
	}

	private async targetWorld(): Promise<string | null> {
		const active = this.app.workspace.getActiveFile();
		const m = active ? /^OnlyWorlds\/Worlds\/([^/]+)\//.exec(active.path) : null;
		if (m) return m[1];
		const name = await this.worldService.getWorldName();
		return name || null;
	}
}
