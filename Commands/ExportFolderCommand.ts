import { App, Modal, Notice, Platform, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { v7 as uuidv7 } from "uuid";
import { readElement, unclosedFenceMessage } from "../vault/element-file";
import { bodyFieldForCategory } from "../vault/element-transform";
import { isHiddenId, isStubNote, type HiddenListHost } from "../sync/hidden-on-server";
import { readWorldIdMarker, writeWorldIdMarker } from "../vault/world-id-marker";
import { readFolderSidecar } from "../vault/folder-sidecar";
import { buildWorldJson, exportedAsFromMe, pluginProducer, serverWorldId, type ExportedAs, type ServerWorld } from "../vault/world-json";
import { V2Client } from "../client-v2";
import { worldFileApiKey } from "../vault/world-key";
import { LOCAL_WORLD_KEY_TOKEN } from "../vault/world-key-core";
import {
	worldFolderName,
	planElementPaths,
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
 *   - world.json carries id + name + every key the world has: World.md's
 *     lines, plus what an import kept in the folder sidecar (spec §4.1);
 *   - all 22 types under elements/<type>/ (spec §4; OW Infra #166 row 13).
 *     Export never writes into an existing folder (both sinks refuse), so an
 *     old export's spatial/ copy can never sit beside a new elements/ one;
 *   - every element body carries `type`; no timestamp is minted, and the
 *     server/sync fields an import carried go back out as received (spec
 *     §4.1, §4.2, §5; OW Infra #166 row 6);
 *   - folder = <slug>-<id8>, files = spec §3.2: <slug>--<id-tail>.json (slug
 *     cap 40), <full-id>.json for an unsluggable name, and the full-id
 *     fallback on a same-type collision (OW Infra #166 row 14).
 *
 * Prose (R3): note body -> description (story for Narrative); [[WikiLink]] ->
 * [Label](ow://type/uuid) where the name resolves. Extension fields round-trip
 * verbatim (R4) — carried by readElement/the transform, never touched here.
 *
 * World identity: World.md carries no world UUID. A downloaded world's
 * world.json.id is the server's, recorded by Download (3.8.0); any other
 * world's is the persisted per-vault world id (readWorldIdMarker), minted once
 * if absent, and the report says so. A stable id keeps re-exports the SAME
 * world in Atlas. Provenance (spec §4.2): `source` and the producer line on a
 * downloaded world, the producer line on a world made in the vault, an
 * imported world's lines as it came (vault/world-json.ts buildWorldJson).
 */
/** The plugin as the export uses it: its hidden lists, its manifest, and the PIN it holds for saves. */
type ExportHost = HiddenListHost & {
	manifest?: { id?: string; version?: string };
	pinCache?: { peek(): string | null };
};

export class ExportFolderCommand {
	private app: App;
	/**
	 * The plugin: its settings, for the hidden lists (OW Infra #426; absent,
	 * only stubs are known), and its manifest, for the producer line (absent,
	 * none is written).
	 */
	private host: ExportHost | null;

	constructor(app: App, host?: ExportHost) {
		this.app = app;
		this.host = host ?? null;
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

	/**
	 * world.json (OW Infra #166 row 5, spec §4.1): World.md's lines plus what an
	 * import kept in the folder sidecar, so every key the world carries goes out
	 * (vault/world-json.ts buildWorldJson says which source wins).
	 */
	private async buildWorldJson(
		world: string,
		worldId: string,
		characterName: (id: string) => string | null = () => null
	): Promise<Record<string, unknown>> {
		let worldMd: string | null = null;
		const file = this.app.vault.getAbstractFileByPath(
			normalizePath(`OnlyWorlds/Worlds/${world}/World.md`)
		);
		if (file instanceof TFile) {
			try {
				worldMd = await this.app.vault.read(file);
			} catch {
				worldMd = null;
			}
		}
		const sidecar = await readFolderSidecar(this.app, world);
		return buildWorldJson({
			worldId,
			worldName: world,
			worldMd,
			kept: sidecar.world ?? null,
			server: sidecar.server ?? null,
			producer: pluginProducer(this.host?.manifest),
			exportedAt: new Date().toISOString(),
			exportedAs: await this.exportedAs(world, sidecar.server ?? null, characterName),
		});
	}

	/**
	 * The slice a downloaded world's key reads (spec §4.2 `exported_as`, OW
	 * Obsidian #557): one GET /me with the key this world's World.md holds.
	 * An `ow_` key reads with no PIN (and a member key's wrong PIN would be
	 * refused); a classic 10-digit key on a world with a PIN is refused a read
	 * without it, so it sends the PIN the plugin already holds for saves,
	 * never prompting for one (Kael, h69 #10539). Null, and nothing said, when the world has
	 * no key (a folder opened with none, a local world), when /me does not
	 * answer, or when it answers for another world: absent, never guessed.
	 * A guest's Character is named from this world's notes, else by one read
	 * of that Character.
	 */
	private async exportedAs(
		world: string,
		server: ServerWorld | null,
		characterName: (id: string) => string | null
	): Promise<ExportedAs | null> {
		const serverId = serverWorldId(server);
		if (!serverId) return null;
		let key: string | null = null;
		try {
			key = (await worldFileApiKey(this.app, world))?.trim() ?? null;
		} catch {
			key = null;
		}
		if (!key || key.toLowerCase() === LOCAL_WORLD_KEY_TOKEN) return null;
		try {
			const pin = key.startsWith("ow_") ? "" : this.host?.pinCache?.peek() ?? "";
			const client = new V2Client(key, pin);
			const me = await client.me();
			if ((me.world as { id?: unknown } | undefined)?.id !== serverId) return null;
			const id = typeof me.character === "string" ? me.character : null;
			let fetched: string | null = null;
			if (id && characterName(id) === null) {
				try {
					const c = await client.get("character", id);
					fetched = typeof c.name === "string" ? c.name : null;
				} catch {
					fetched = null;
				}
			}
			return exportedAsFromMe(me, (cid) => characterName(cid) ?? (cid === id ? fetched : null));
		} catch (error) {
			console.warn("OnlyWorlds: /me did not answer; the export carries no exported_as.", error);
			return null;
		}
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
		hidden: number;
	} | null> {
		const files = this.elementFilesFor(world);
		if (files.length === 0) {
			new Notice(`No element notes found in ${world}.`);
			return null;
		}

		// Pass 1 — read every element (frontmatter, span-tolerant) and build a
		// note path -> ref index for wikilink resolution: a `[[link]]` names the
		// note Obsidian resolves it to, never an element by name alone, so two
		// same-name twins keep their own ids (round C, 3).
		const elements: { type: string; payload: Record<string, unknown>; path: string }[] = [];
		const failed: { path: string; reason: string }[] = [];
		const byPath = new Map<string, ElementRef>();
		// This world's notes by file name (lower case), for a link Obsidian
		// resolves to no element note of this world (the fix round, item 2;
		// Kael's fixes read, low 6).
		const byName = new Map<string, ElementRef[]>();
		// Element notes of this world refused for an open fence: a link that
		// lands on one is left as written, never sent to a same-name note.
		const refusedPaths = new Set<string>();
		// Hidden by the world's owner (OW Infra #426): a stub, or an id on a
		// hidden list, is no element to carry; counted on its own line.
		let hidden = 0;
		for (const file of files) {
			try {
				if (isStubNote(await this.app.vault.read(file))) {
					hidden++;
					refusedPaths.add(file.path);
					continue;
				}
				const parsed = await readElement(this.app, file);
				if (!parsed || !parsed.id) {
					failed.push({ path: file.path, reason: "no id / unreadable" });
					continue;
				}
				if (this.host && isHiddenId(this.host.settings, parsed.id)) {
					hidden++;
					refusedPaths.add(file.path);
					continue;
				}
				if (parsed.unclosedFence) {
					// Never written cut short (round C, 1).
					failed.push({ path: file.path, reason: unclosedFenceMessage(parsed.name, parsed.unclosedFence) });
					refusedPaths.add(file.path);
					continue;
				}
				// A known-of note is written as the stub it is: `known_of: true`
				// and only what it keeps (the folder spec §4.4 rule 1, OW Infra #454).
				const payload: Record<string, unknown> = { ...parsed.fields, id: parsed.id, name: parsed.name };
				if (parsed.knownOf) payload.known_of = true;
				elements.push({ type: parsed.category, payload, path: file.path });
				const ref = { id: parsed.id, name: parsed.name, type: parsed.category };
				byPath.set(file.path, ref);
				const key = file.basename.toLowerCase();
				byName.set(key, [...(byName.get(key) ?? []), ref]);
			} catch (e) {
				failed.push({ path: file.path, reason: e instanceof Error ? e.message : String(e) });
			}
		}
		if (elements.length === 0) {
			new Notice(`Export aborted — no readable elements in ${world}.`);
			return null;
		}

		// Pass 2 — translate prose, build folder bodies, plan relative paths. No
		// timestamp is minted; what an import carried goes back out (row 6).
		const sidecar = await readFolderSidecar(this.app, world);
		const carriedById = sidecar.elements ?? {};
		const orderById = sidecar.order ?? {};
		// A guest's Character, for `exported_as`, named as its note names it.
		const characters = new Map<string, string>();
		for (const el of elements) {
			if (el.type.toLowerCase() === "character" && typeof el.payload.name === "string") characters.set(String(el.payload.id), el.payload.name);
		}
		const worldJson = await this.buildWorldJson(world, worldId, (id) => characters.get(id) ?? null);
		const planned: { rel: string; content: string }[] = [
			{ rel: "world.json", content: JSON.stringify(worldJson, null, 2) + "\n" },
		];
		// Filenames per spec §3.2, with its writer collision rule (row 14).
		const paths = planElementPaths(
			elements.map((el) => ({ type: el.type, id: String(el.payload.id), name: el.payload.name }))
		);
		for (const el of elements) {
			const bodyField = bodyFieldForCategory(el.type);
			const payload = { ...el.payload };
			if (typeof payload[bodyField] === "string") {
				payload[bodyField] = wikilinksToOwMentions(
					payload[bodyField] as string,
					(n) => {
						const dest = this.app.metadataCache.getFirstLinkpathDest(n, el.path);
						const picked = dest ? byPath.get(dest.path) : undefined;
						if (picked) return picked;
						if (dest && refusedPaths.has(dest.path)) return null;
						// Obsidian's pick is no element note of this world: in a
						// vault with two worlds (Copy World, then Paste World) it
						// can land on the other world's note, or on a plain note
						// with no id inside this one. Then this world's own element
						// note by that name answers, when exactly one does, as the
						// save's resolver does (buildWikilinkResolver); never a guess.
						const named = byName.get((n.split("/").pop() ?? n).replace(/\.md$/i, "").toLowerCase()) ?? [];
						return named.length === 1 ? named[0] : null;
					}
				);
			}
			const body = buildFolderElementBody(
				el.type,
				payload,
				carriedById[String(el.payload.id)] ?? {},
				orderById[String(el.payload.id)]
			);
			const rel = paths.get(String(el.payload.id)) as string;
			planned.push({ rel, content: JSON.stringify(body, null, 2) + "\n" });
		}
		return { files: planned, failed, hidden };
	}

	private async exportWorld(world: string, dest: ExportDestination): Promise<void> {
		const { worldId, idNote } = await this.worldIdFor(world);
		const folderName = worldFolderName(world, worldId);

		const plan = await this.planFiles(world, worldId);
		if (!plan) return;
		const report = { ...plan, idNote };

		if (dest.kind === "external") {
			await this.writeExternal(world, folderName, dest.dir, report);
		} else {
			await this.writeVault(world, folderName, report);
		}
	}

	/**
	 * The world id an export writes (spec §4.1: a portable copy keeps the
	 * world `id`). A downloaded world's is the server's, which Download
	 * recorded in the folder sidecar; else the persisted per-vault id; else
	 * one is minted and persisted, so re-exports stay the SAME world in Atlas
	 * and the import guard does not trip on its own earlier import. A mint, or
	 * a world holding a server key whose id no Download has recorded yet (one
	 * downloaded before 3.8.0), gets a line in the report.
	 */
	private async worldIdFor(world: string): Promise<{ worldId: string; idNote: string | null }> {
		const fromServer = serverWorldId((await readFolderSidecar(this.app, world)).server);
		if (fromServer) return { worldId: fromServer, idNote: null };
		let worldId = await readWorldIdMarker(this.app, world);
		const minted = !worldId;
		if (!worldId) {
			worldId = uuidv7();
			await writeWorldIdMarker(this.app, world, worldId);
		}
		let key: string | null = null;
		try {
			key = await worldFileApiKey(this.app, world);
		} catch {
			key = null;
		}
		if (key && key.trim() && key.trim().toLowerCase() !== LOCAL_WORLD_KEY_TOKEN) {
			return { worldId, idNote: "This world's server id is not recorded yet: download the world again, then export, to keep it." };
		}
		return { worldId, idNote: minted ? "New world id: this world has no server id in this vault." : null };
	}

	/** Vault sink (default): unchanged behavior — vault API under OW-folder-export/. */
	private async writeVault(
		world: string,
		folderName: string,
		plan: { files: { rel: string; content: string }[]; failed: { path: string; reason: string }[]; hidden: number; idNote: string | null }
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
		}, plan.files.length, plan.failed, plan.hidden, plan.idNote).open();
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
		plan: { files: { rel: string; content: string }[]; failed: { path: string; reason: string }[]; hidden: number; idNote: string | null }
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
		}, plan.files.length, plan.failed, plan.hidden, plan.idNote).open();
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
		private failed: { path: string; reason: string }[],
		private hidden = 0,
		/** The world id's line (a mint, or a server id not recorded yet; ExportFolderCommand.worldIdFor). */
		private idNote: string | null = null
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
		if (this.hidden > 0) {
			summary.createEl("li", { text: `${this.hidden} note${this.hidden === 1 ? "" : "s"} hidden by the world's owner, not exported` });
		}
		if (this.idNote) summary.createEl("li", { text: this.idNote });

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
					"world.json + elements/.)"
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
