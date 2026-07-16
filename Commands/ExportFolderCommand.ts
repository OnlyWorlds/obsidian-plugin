import { App, Modal, Notice, Platform, Setting, TFile, TFolder, normalizePath } from "obsidian";
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
import {
	joinExternal,
	checkExternalTarget,
	ATLAS_OPEN_MARKERS,
	type ExportDestination,
} from "./export-plan";

/**
 * Export as OnlyWorlds folder (S9 Phase C / Rail 2, + S9 destination picker).
 *
 * Walks a world's element notes and writes a conformant OnlyWorlds folder — the
 * Track H standard Atlas reads directly. The user chooses WHERE it lands (R1):
 *   - (default) IN THE VAULT — `OW-folder-export/<slug>-<id8>/`, vault API. The
 *     zero-friction, mobile-safe default; the user moves it into Atlas by hand.
 *   - CHOOSE A FOLDER… — a real OS directory (e.g. their Atlas root), written
 *     with node fs/promises + absolute paths (R2) so the bytes actually escape
 *     the vault sandbox. Desktop-only; hidden on mobile (no Atlas there).
 *
 * The serialization (world.json + element bodies + ow:// prose) is identical for
 * both destinations — only the SINK differs (vault.create vs fs.writeFile). See
 * planFiles(): it produces the in-memory file list once; a sink writes it.
 *
 * THE ELECTRON UNKNOWN (disclosed): the native directory picker is reached by
 * probing several known renderer paths at runtime (pickDirectoryNative). Obsidian
 * dropped Electron's `remote` module years ago, and `@electron/remote` is not
 * bundled into plugins, so no single path is guaranteed. If none resolves we FALL
 * BACK to a paste-absolute-path modal — an acceptable ship (brief R1 / gate note).
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
 * World identity: World.md carries no world UUID, so world.json.id is the
 * persisted per-vault world id (readWorldIdMarker), minted once if absent. A
 * stable id keeps re-exports the SAME world in Atlas.
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
		new WorldPickModal(this.app, worlds, (world) => {
			new DestinationPickModal(this.app, (dest) => void this.exportWorld(world, dest)).open();
		}).open();
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

	/**
	 * Build the complete in-memory file list for a world export: world.json plus
	 * every element body, each as { rel, content } with the same bytes regardless
	 * of sink. Returns null (with a Notice) when there is nothing to write.
	 */
	private async planFiles(
		world: string,
		worldId: string
	): Promise<{
		files: { rel: string; content: string }[];
		failed: { path: string; reason: string }[];
	} | null> {
		const files = this.elementFilesFor(world);
		if (files.length === 0) {
			new Notice(`No element notes found in ${world}.`);
			return null;
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
			return null;
		}

		// Pass 2 — translate prose, stamp folder bodies, plan relative paths.
		const stamp = new Date().toISOString();
		const worldMeta = await this.readWorldMeta(world);
		const planned: { rel: string; content: string }[] = [
			{
				rel: "world.json",
				content: JSON.stringify({ id: worldId, name: world, ...worldMeta }, null, 2) + "\n",
			},
		];
		for (const el of elements) {
			const bodyField = bodyFieldForCategory(el.type);
			const payload = { ...el.payload };
			if (typeof payload[bodyField] === "string") {
				payload[bodyField] = wikilinksToOwMentions(
					payload[bodyField] as string,
					(n) => nameIndex.get(n) ?? null
				);
			}
			const body = buildFolderElementBody(el.type, payload, stamp);
			const rel = elementRelPath(el.type, { id: String(el.payload.id), name: el.payload.name });
			planned.push({ rel, content: JSON.stringify(body, null, 2) + "\n" });
		}
		return { files: planned, failed };
	}

	private async exportWorld(world: string, dest: ExportDestination): Promise<void> {
		// STABLE world identity: read the persisted per-vault world id, mint only
		// if none exists yet. A fresh id per export would make every re-export a
		// NEW world in Atlas and trip the import guard against its own earlier
		// import.
		let worldId = await readWorldIdMarker(this.app, world);
		if (!worldId) {
			worldId = uuidv7();
			await writeWorldIdMarker(this.app, world, worldId);
		}
		const folderName = worldFolderName(world, worldId);

		const plan = await this.planFiles(world, worldId);
		if (!plan) return;

		if (dest.kind === "external") {
			await this.writeExternal(world, folderName, dest.dir, plan);
		} else {
			await this.writeVault(world, folderName, plan);
		}
	}

	/** Vault sink (default): unchanged behavior — vault API under OW-folder-export/. */
	private async writeVault(
		world: string,
		folderName: string,
		plan: { files: { rel: string; content: string }[]; failed: { path: string; reason: string }[] }
	): Promise<void> {
		const root = normalizePath(`OW-folder-export/${folderName}`);
		if (this.app.vault.getAbstractFileByPath(root)) {
			new Notice(
				`An export folder named ${folderName} already exists. Move or delete it first.`,
				8000
			);
			return;
		}
		try {
			await this.ensureVaultFolder(root);
			for (const f of plan.files) {
				const full = normalizePath(`${root}/${f.rel}`);
				await this.ensureVaultFolder(full.substring(0, full.lastIndexOf("/")));
				await this.app.vault.create(full, f.content);
			}
		} catch (e) {
			new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
			return;
		}
		new ExportReportModal(this.app, world, {
			kind: "vault",
			display: `OW-folder-export/${folderName}/`,
		}, plan.files.length, plan.failed).open();
	}

	/**
	 * External sink (R2): node fs/promises + ABSOLUTE paths so the write escapes
	 * the vault sandbox. R3 preflight: refuse if the target already exists or the
	 * chosen dir holds an open Atlas world (.atlas / lock).
	 */
	private async writeExternal(
		world: string,
		folderName: string,
		destDir: string,
		plan: { files: { rel: string; content: string }[]; failed: { path: string; reason: string }[] }
	): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs/promises") as typeof import("fs/promises");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path") as typeof import("path");

		const target = joinExternal(destDir, folderName, path.sep);

		// R3 preflight — cheap probes, then pure refusal logic.
		let targetExists = false;
		try {
			await fs.stat(target);
			targetExists = true;
		} catch {
			/* absent — good */
		}
		let destHasAtlasLock = false;
		try {
			const entries = await fs.readdir(destDir);
			const markers = new Set<string>(ATLAS_OPEN_MARKERS);
			destHasAtlasLock = entries.some((e) => markers.has(e));
		} catch {
			/* dir unreadable/absent — checkExternalTarget will not flag atlas-open */
		}
		const verdict = checkExternalTarget(folderName, targetExists, destHasAtlasLock);
		if (!verdict.ok) {
			new Notice(verdict.message, 10000);
			return;
		}

		try {
			for (const f of plan.files) {
				const full = path.join(target, ...f.rel.split("/"));
				await fs.mkdir(path.dirname(full), { recursive: true });
				await fs.writeFile(full, f.content, "utf8");
			}
		} catch (e) {
			new Notice(
				`Export failed writing to ${target}: ${e instanceof Error ? e.message : String(e)}`,
				10000
			);
			return;
		}
		new ExportReportModal(this.app, world, {
			kind: "external",
			display: target,
		}, plan.files.length, plan.failed).open();
	}

	private async ensureVaultFolder(path: string): Promise<void> {
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

/**
 * Probe for a reachable native directory picker and, if found, open it.
 * Returns the chosen absolute dir, or null if the user cancelled OR no native
 * dialog API is reachable in this Obsidian/Electron build.
 *
 * We try, in order, the renderer-reachable paths that have appeared across
 * Obsidian/Electron versions. Each is fully guarded — a throw or undefined at any
 * step just moves to the next, and exhausting them returns null so the caller can
 * fall back to the paste-path modal. `showOpenDialog` (async, main-process
 * marshalled) is preferred; `showOpenDialogSync` is the older renderer form.
 */
async function pickDirectoryNative(): Promise<string | null> {
	type DialogLike = {
		showOpenDialog?: (opts: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
		showOpenDialogSync?: (opts: unknown) => string[] | undefined;
	};
	const opts = {
		title: "Choose export destination (e.g. your Atlas root)",
		properties: ["openDirectory", "createDirectory"],
	};

	const candidates: (() => DialogLike | undefined)[] = [
		// Modern main-process dialog via @electron/remote, IF a host bundles it.
		() => tryRequire("@electron/remote")?.dialog as DialogLike | undefined,
		// Legacy renderer `remote` (gone in current Electron, kept for old hosts).
		() => tryRequire("electron")?.remote?.dialog as DialogLike | undefined,
		// Some Obsidian builds expose electron on window with a remote bridge.
		() => (window as unknown as { electron?: { remote?: { dialog?: DialogLike } } })
			.electron?.remote?.dialog,
		// Direct renderer dialog (present in a few Electron configurations).
		() => tryRequire("electron")?.dialog as DialogLike | undefined,
	];

	for (const get of candidates) {
		let dialog: DialogLike | undefined;
		try {
			dialog = get();
		} catch {
			continue;
		}
		if (!dialog) continue;
		try {
			if (typeof dialog.showOpenDialog === "function") {
				const res = await dialog.showOpenDialog(opts);
				if (res.canceled || res.filePaths.length === 0) return null;
				return res.filePaths[0];
			}
			if (typeof dialog.showOpenDialogSync === "function") {
				const paths = dialog.showOpenDialogSync(opts);
				return paths && paths.length > 0 ? paths[0] : null;
			}
		} catch {
			// This dialog surfaced but failed to open — try the next candidate.
			continue;
		}
	}
	return null;
}

/** require() that never throws — returns undefined if the module isn't present. */
function tryRequire(id: string): any {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require(id);
	} catch {
		return undefined;
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
			text: "Pick a world to export as a conformant OnlyWorlds folder.",
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

/**
 * Destination picker (R1): choose IN THE VAULT (default) or an external folder.
 * The external branch is desktop-only — hidden on mobile (Platform.isMobile),
 * which has no Atlas and no reachable OS picker. Choosing external opens the
 * native picker, falling back to a paste-path modal if none is reachable.
 */
class DestinationPickModal extends Modal {
	constructor(app: App, private onPick: (dest: ExportDestination) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Where should the folder go?" });

		new Setting(contentEl)
			.setName("In the vault (default)")
			.setDesc("Writes under OW-folder-export/ in this vault. Move it into your Atlas root after.")
			.addButton((b) =>
				b
					.setButtonText("Use vault")
					.setCta()
					.onClick(() => {
						this.close();
						this.onPick({ kind: "vault" });
					})
			);

		if (!Platform.isMobile) {
			new Setting(contentEl)
				.setName("Choose a folder…")
				.setDesc(
					"Write straight into a folder you pick — point it at your Atlas root " +
						"(…/onlyworlds-atlas/) for a one-step handoff."
				)
				.addButton((b) =>
					b.setButtonText("Choose folder").onClick(() => {
						this.close();
						void this.chooseExternal();
					})
				);
		}
	}

	private async chooseExternal(): Promise<void> {
		const dir = await pickDirectoryNative();
		if (dir) {
			this.onPick({ kind: "external", dir });
			return;
		}
		// No native picker reachable (or cancelled) — offer the paste-path modal.
		new PastePathModal(this.app, (typed) => this.onPick({ kind: "external", dir: typed })).open();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Fallback when no native directory picker is reachable: the user pastes an
 * absolute path. Empty input cancels. No path validation here — the external
 * sink's fs write surfaces any bad path as a clear failure Notice.
 */
class PastePathModal extends Modal {
	private value = "";
	constructor(app: App, private onSubmit: (dir: string) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Paste destination folder" });
		const p = contentEl.createEl("p", {
			text:
				"No system folder picker was available. Paste the ABSOLUTE path of the " +
				"destination folder (e.g. your Atlas root).",
		});
		p.style.fontSize = "0.9em";

		new Setting(contentEl).setName("Absolute path").addText((t) => {
			t.setPlaceholder("C:\\Users\\you\\Desktop\\TESTOWFOLDER\\onlyworlds-atlas");
			t.onChange((v) => (this.value = v.trim()));
			t.inputEl.style.width = "100%";
		});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Write here")
					.setCta()
					.onClick(() => {
						if (!this.value) {
							new Notice("Enter an absolute path, or cancel.");
							return;
						}
						this.close();
						this.onSubmit(this.value);
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
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
		private dest: { kind: "vault" | "external"; display: string },
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
		where.appendText(this.dest.display);

		const next = contentEl.createEl("p");
		next.style.fontSize = "0.9em";
		if (this.dest.kind === "external") {
			next.appendText("Open Atlas to see it — if you wrote into your Atlas root, it appears on next open.");
		} else {
			next.appendText(
				"To open in Atlas: move this folder into your Atlas root, or re-run export " +
					"and choose that folder directly. (The folder is self-contained — " +
					"world.json + elements/ + spatial/.)"
			);
		}

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
