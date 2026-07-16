import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { v7 as uuidv7 } from "uuid";
import { readElement } from "../vault/element-file";
import { bodyFieldForCategory } from "../vault/element-transform";
import { readWorldIdMarker, writeWorldIdMarker } from "../vault/world-id-marker";
import {
	worldFolderName,
	elementRelPath,
	buildFolderElementBody,
	wikilinksToOwMentions,
	type ElementRef,
} from "../vault/folder-format";

/**
 * Export as OnlyWorlds folder (S9 Phase C / Rail 2).
 *
 * Walks a world's element notes and writes a conformant OnlyWorlds folder — the
 * Track H standard Atlas reads directly. VAULT-INTERNAL only (R2): the folder is
 * written under `OW-folder-export/<slug>-<id8>/` inside the vault. The user moves
 * it into their Atlas root themselves (the completion notice says so). No node
 * fs, no paths outside the vault — mobile-safe, permission-clean.
 *
 * Conformance (R1, from the gold-standard writer azgaar-converter/src/folder.js):
 *   - world.json carries id + name (+ readable World.md meta);
 *   - spatial types under spatial/<type>/, others under elements/<type>/;
 *   - every element body stamps type + local_updated_at + created_at;
 *   - folder = <slug>-<id8>, files = <slug>--<id-tail>.json.
 *
 * Prose (R3): note body -> description (story for Narrative); [[WikiLink]] ->
 * [Label](ow://type/uuid) where the name resolves. Extension fields round-trip
 * verbatim (R4) — carried by readElement/the transform, never touched here.
 *
 * World identity (disclosed judgment call): World.md carries no world UUID (only
 * api_key + readable meta — see Scripts/WorldDataTemplate.ts). So world.json.id
 * is minted here as a fresh UUIDv7 — exactly what folder.js does for its own
 * world.json. Element ids are the real note ids and are preserved.
 */
export class ExportFolderCommand {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async execute(): Promise<void> {
		const worlds = this.getWorldFolders();
		if (worlds.length === 0) {
			new Notice("No OnlyWorlds worlds found in this vault.");
			return;
		}
		new WorldPickModal(this.app, worlds, (world) => void this.exportWorld(world)).open();
	}

	private getWorldFolders(): string[] {
		const root = this.app.vault.getAbstractFileByPath(normalizePath("OnlyWorlds/Worlds"));
		if (!(root instanceof TFolder)) return [];
		return root.children.filter((c): c is TFolder => c instanceof TFolder).map((f) => f.name);
	}

	private elementFilesFor(world: string): TFile[] {
		const prefix = `OnlyWorlds/Worlds/${world}/Elements/`;
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	}

	/** Parse the readable meta out of World.md's span-list body (best-effort). */
	private async readWorldMeta(world: string): Promise<Record<string, unknown>> {
		const meta: Record<string, unknown> = {};
		const file = this.app.vault.getAbstractFileByPath(
			normalizePath(`OnlyWorlds/Worlds/${world}/World.md`)
		);
		if (!(file instanceof TFile)) return meta;
		try {
			const content = await this.app.vault.read(file);
			const grab = (label: string): string | null => {
				const m = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, "m").exec(content);
				return m ? m[1].trim() : null;
			};
			const desc = grab("Description");
			const version = grab("Version");
			if (desc) meta.description = desc;
			if (version) meta.version = version;
		} catch {
			/* best-effort meta */
		}
		return meta;
	}

	private async exportWorld(world: string): Promise<void> {
		const files = this.elementFilesFor(world);
		if (files.length === 0) {
			new Notice(`No element notes found in ${world}.`);
			return;
		}

		// Pass 1 — read every element (frontmatter, span-tolerant) and build a
		// name -> ref index for wikilink resolution.
		const elements: { type: string; payload: Record<string, unknown> }[] = [];
		const failed: { path: string; reason: string }[] = [];
		const nameIndex = new Map<string, ElementRef>();
		for (const file of files) {
			try {
				const parsed = await readElement(this.app, file);
				if (!parsed || !parsed.id) {
					failed.push({ path: file.path, reason: "no id / unreadable" });
					continue;
				}
				const payload = { ...parsed.fields, id: parsed.id, name: parsed.name };
				elements.push({ type: parsed.category, payload });
				nameIndex.set(parsed.name, { id: parsed.id, name: parsed.name, type: parsed.category });
			} catch (e) {
				failed.push({ path: file.path, reason: e instanceof Error ? e.message : String(e) });
			}
		}
		if (elements.length === 0) {
			new Notice(`Export aborted — no readable elements in ${world}.`);
			return;
		}

		// Pass 2 — translate prose, stamp folder bodies, plan paths, write.
		const stamp = new Date().toISOString();
		// STABLE world identity (keeper ruling, 2026-07-16): read the persisted
		// per-vault world id, mint only if none exists yet, persist what we mint.
		// A fresh id per export would make every re-export a NEW world in Atlas
		// and trip the import guard against this world's own earlier import.
		let worldId = await readWorldIdMarker(this.app, world);
		if (!worldId) {
			worldId = uuidv7();
			await writeWorldIdMarker(this.app, world, worldId);
		}
		const folderName = worldFolderName(world, worldId);
		const root = normalizePath(`OW-folder-export/${folderName}`);
		if (this.app.vault.getAbstractFileByPath(root)) {
			new Notice(
				`An export folder named ${folderName} already exists. Move or delete it first.`,
				8000
			);
			return;
		}

		const written: string[] = [];
		try {
			// world.json (R1a).
			const worldMeta = await this.readWorldMeta(world);
			await this.ensureFolder(root);
			await this.app.vault.create(
				normalizePath(`${root}/world.json`),
				JSON.stringify({ id: worldId, name: world, ...worldMeta }, null, 2) + "\n"
			);
			written.push("world.json");

			for (const el of elements) {
				const bodyField = bodyFieldForCategory(el.type);
				const payload = { ...el.payload };
				// Translate body prose wikilinks -> ow:// where they resolve (R3).
				if (typeof payload[bodyField] === "string") {
					payload[bodyField] = wikilinksToOwMentions(
						payload[bodyField] as string,
						(n) => nameIndex.get(n) ?? null
					);
				}
				const body = buildFolderElementBody(el.type, payload, stamp);
				const rel = elementRelPath(el.type, { id: String(el.payload.id), name: el.payload.name });
				const full = normalizePath(`${root}/${rel}`);
				await this.ensureFolder(full.substring(0, full.lastIndexOf("/")));
				await this.app.vault.create(full, JSON.stringify(body, null, 2) + "\n");
				written.push(rel);
			}
		} catch (e) {
			new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
			return;
		}

		new ExportReportModal(this.app, world, folderName, written.length, failed).open();
	}

	private async ensureFolder(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (!norm || this.app.vault.getAbstractFileByPath(norm)) return;
		const parts = norm.split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				await this.app.vault.createFolder(cur);
			}
		}
	}
}

/** World picker (export copy). */
class WorldPickModal extends Modal {
	constructor(app: App, private worlds: string[], private onPick: (world: string) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Export as OnlyWorlds folder" });
		const p = contentEl.createEl("p", {
			text:
				"Writes this world as a conformant OnlyWorlds folder under " +
				"OW-folder-export/ in this vault. Move that folder into your Atlas root " +
				"to open it in Atlas.",
		});
		p.style.fontSize = "0.9em";
		for (const world of this.worlds) {
			new Setting(contentEl).setName(world).addButton((b) =>
				b
					.setButtonText("Export")
					.setCta()
					.onClick(() => {
						this.close();
						this.onPick(world);
					})
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** End-of-run report. */
class ExportReportModal extends Modal {
	constructor(
		app: App,
		private world: string,
		private folderName: string,
		private writtenCount: number,
		private failed: { path: string; reason: string }[]
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Exported — ${this.world}` });

		const summary = contentEl.createEl("ul");
		summary.createEl("li", { text: `${this.writtenCount} files written (incl. world.json)` });
		summary.createEl("li", { text: `${this.failed.length} notes skipped (unreadable)` });

		const where = contentEl.createEl("p");
		where.createEl("strong", { text: "Folder: " });
		where.appendText(`OW-folder-export/${this.folderName}/`);

		const next = contentEl.createEl("p");
		next.style.fontSize = "0.9em";
		next.appendText(
			"To open in Atlas: move this folder out of the vault and into your Atlas root. " +
				"(The folder is self-contained — world.json + elements/ + spatial/.)"
		);

		if (this.failed.length > 0) {
			contentEl.createEl("h3", { text: "Skipped notes" });
			const list = contentEl.createEl("ul");
			for (const f of this.failed) list.createEl("li", { text: `${f.path} — ${f.reason}` });
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Close").setCta().onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
