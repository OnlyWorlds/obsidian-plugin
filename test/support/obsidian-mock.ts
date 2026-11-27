/**
 * A minimal in-memory stand-in for the `obsidian` module, so tests can drive
 * the REAL Obsidian-facing wiring (vault/element-file.ts writeElement /
 * readElement, Commands/ImportFolderCommand.ts) instead of a model of it.
 *
 * Installed by ./obsidian-shim.ts, which must be imported FIRST. Tests import
 * from here directly for `makeApp` and the parser switch.
 *
 * What is emulated, and how faithfully:
 *   - Vault: a path -> content map. create / modify / process / read / createFolder /
 *     delete (a file, or an empty folder only; recorded in `deletes`),
 *     getAbstractFileByPath, getFiles, getMarkdownFiles, adapter.{exists,read,write,list},
 *     and adapter.{readBinary,writeBinary,mkdir}: bytes written as bytes read
 *     back exactly (the folder's `records/`).
 *     `create` refuses an existing path, as Obsidian does.
 *   - metadataCache.getFileCache: parses the frontmatter synchronously from the
 *     current content (an always-warm cache) — UNLESS `coldCache` is set, in
 *     which case it returns no frontmatter at all, the way a freshly written
 *     note looks to real Obsidian before it has been indexed.
 *   - metadataCache.getFirstLinkpathDest: basename match (case-insensitive),
 *     same-folder preference, else first by path. An emulation, not Obsidian's.
 *   - parseYaml: js-yaml 4 by default; `setYamlParser("yaml")` switches to the
 *     `yaml` 2.x package. Which of the two Obsidian's own parseYaml behaves like
 *     is not known here, so tests that care run under BOTH.
 *   - Modal / Setting / Notice: record-only stubs, no DOM.
 *   - requestUrl: no network. Every call is recorded in `__requests` (url,
 *     method, headers, body) and answered by the handler a test sets with
 *     `setRequestUrl`; with none set, a call fails the test. `throw` behaves as
 *     Obsidian's does: a status of 400 or more throws unless `throw: false`.
 *   - adapter.write to a path with no dot-segment writes a real note (Obsidian
 *     creates a file the vault then lists); a dot-path stays a hidden file.
 *   - Open editors: app.openEditor(path, text) puts a markdown view on a note
 *     holding unsaved text (workspace.getLeavesOfType("markdown") lists it);
 *     its save() writes that text. The editor's reload after another writer
 *     changes the file is not modelled.
 *   - vault.getName() is "Test Vault"; workspace.getLeaf().openFile records the
 *     path in `opened`; fileManager.renameFile and
 *     workspace.openLinkText only record or do nothing (fileManager.trashFile
 *     records in `trashed` and removes a file or an empty folder), unless a test sets
 *     `realRenames` on the app: then renameFile also moves the file or the
 *     folder with everything under it, as Obsidian does.
 *   - `vault.caseInsensitive` (off by default) makes the disk behave like
 *     Windows' or macOS': adapter.exists(p) matches any case unless asked to be
 *     `sensitive`, and create refuses a path differing only in case. The vault's
 *     own lookup (getAbstractFileByPath) stays exact, as Obsidian's does.
 */
import type { App as ObsidianApp } from "obsidian";
// Both parsers are in node_modules through the eslint toolchain, not as
// declared dependencies; js-yaml ships no types and there is no @types/js-yaml.
// eslint-disable-next-line import/no-extraneous-dependencies
import { parse as yaml2Parse } from "yaml";
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, import/no-extraneous-dependencies
const jsYaml = require("js-yaml") as { load(s: string): unknown };

let parser: "js-yaml" | "yaml" = "js-yaml";
export function setYamlParser(p: "js-yaml" | "yaml"): void {
	parser = p;
}
export function parseYaml(s: string): unknown {
	return parser === "yaml" ? (yaml2Parse(s) as unknown) : jsYaml.load(s);
}
export function stringifyYaml(o: unknown): string {
	return JSON.stringify(o);
}

export function normalizePath(p: string): string {
	let s = String(p).replace(/\\/g, "/").replace(/\/+/g, "/");
	s = s.replace(/^\/+|\/+$/g, "");
	return s === "" ? "/" : s.normalize("NFC");
}

export class TAbstractFile {
	name: string;
	parent: TFolder | null = null;
	constructor(public vault: MockVault, public path: string) {
		this.name = path.split("/").pop() ?? path;
	}
}
export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	constructor(vault: MockVault, p: string) {
		super(vault, p);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1).toLowerCase() : ""; // real Obsidian lowercases it (seen 2026-11-24: `x.JSON` reads "json")
	}
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/";
	}
}

export const __notices: string[] = [];
export class Notice {
	constructor(msg: unknown) {
		__notices.push(String(msg));
	}
}
export const __modals: Modal[] = [];
export class Modal {
	contentEl = { empty(): void {}, createEl: () => ({ createEl: () => ({}), style: {} }) };
	constructor(public app: unknown) {}
	open(): void {
		__modals.push(this);
	}
	close(): void {}
}
export class Setting {
	setName(): this { return this; }
	setDesc(): this { return this; }
	addButton(): this { return this; }
	addText(): this { return this; }
	addToggle(): this { return this; }
}
export const Platform = { isMobile: false, isDesktop: true };
/** A dropdown that records its options; its select is a child of the container when the container can make one. */
export class DropdownComponent {
	selectEl: { addClass(c: string): void; style: Record<string, string> };
	options: string[] = [];
	private value = "";
	constructor(containerEl: { createEl?: (tag: string) => unknown }) {
		const made = containerEl?.createEl?.("select") as DropdownComponent["selectEl"] | undefined;
		this.selectEl = made && typeof made.addClass === "function" ? made : { addClass(): void {}, style: {} };
	}
	addOption(value: string): this {
		this.options.push(value);
		if (!this.value) this.value = value;
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	getValue(): string {
		return this.value;
	}
}

export interface MockRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}
export interface MockResponse {
	status: number;
	json?: unknown;
	text?: string;
	/** Response headers (lower-case names, as Obsidian's requestUrl gives them). */
	headers?: Record<string, string>;
}
export const __requests: MockRequest[] = [];
let requestHandler: ((r: MockRequest) => MockResponse) | null = null;
/** Answer every requestUrl call with `h` from now on, and clear the record. */
export function setRequestUrl(h: (r: MockRequest) => MockResponse): void {
	requestHandler = h;
	__requests.length = 0;
}
export async function requestUrl(req: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}): Promise<{ status: number; text: string; json: unknown; headers: Record<string, string> }> {
	const r: MockRequest = { url: req.url, method: req.method ?? "GET", headers: { ...(req.headers ?? {}) }, body: req.body };
	__requests.push(r);
	if (!requestHandler) throw new Error(`no requestUrl stub for ${r.method} ${r.url}`);
	const res = requestHandler(r);
	const text = res.text ?? (res.json === undefined ? "" : JSON.stringify(res.json));
	if (req.throw !== false && res.status >= 400) throw new Error(`Request failed, status ${res.status}`);
	let json: unknown = res.json;
	if (json === undefined && text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
	}
	return { status: res.status, text, json, headers: res.headers ?? {} };
}

export class MockVault {
	files = new Map<string, { file: TFile; content: string }>();
	folders = new Map<string, TFolder>();
	dotfiles = new Map<string, string>();
	/**
	 * Bytes written as bytes (adapter.writeBinary, seedBinary): read back by
	 * readBinary exactly; a text write to the path drops them. A path with no
	 * entry here reads its text as UTF-8.
	 */
	binaries = new Map<string, Uint8Array>();
	/** The disk is case-insensitive (Windows, macOS): see the header. */
	caseInsensitive = false;
	private onDisk(p: string): boolean {
		if (this.dotfiles.has(p) || this.files.has(p) || this.folders.has(p)) return true;
		if (!this.caseInsensitive) return false;
		const low = p.toLowerCase();
		return [...this.dotfiles.keys(), ...this.files.keys(), ...this.folders.keys()].some((k) => k.toLowerCase() === low);
	}
	adapter = {
		/** The disk's direct children of a folder, hidden files included (the vault lists none of those). */
		list: async (p: string): Promise<{ files: string[]; folders: string[] }> => {
			p = normalizePath(p);
			const under = (k: string) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/");
			return {
				files: [...this.files.keys(), ...this.dotfiles.keys()].filter(under),
				folders: [...this.folders.keys()].filter(under),
			};
		},
		exists: async (p: string, sensitive?: boolean) => {
			p = normalizePath(p);
			if (sensitive) return this.dotfiles.has(p) || this.files.has(p) || this.folders.has(p);
			return this.onDisk(p);
		},
		read: async (p: string) => {
			p = normalizePath(p);
			if (this.dotfiles.has(p)) return this.dotfiles.get(p) as string;
			const e = this.files.get(p);
			if (e) return e.content;
			throw new Error("ENOENT " + p);
		},
		/** The bytes at a path: as written by writeBinary, else its text as UTF-8. */
		readBinary: async (p: string): Promise<ArrayBuffer> => {
			p = normalizePath(p);
			const b = this.binaries.get(p);
			const bytes = b ?? (this.dotfiles.has(p) ? new TextEncoder().encode(this.dotfiles.get(p)) : this.files.has(p) ? new TextEncoder().encode(this.files.get(p)?.content) : null);
			if (!bytes) throw new Error("ENOENT " + p);
			return bytes.slice().buffer;
		},
		/** Bytes kept exactly; the file is listed like any other (a dot-path stays hidden). */
		writeBinary: async (p: string, data: ArrayBuffer) => {
			p = normalizePath(p);
			const bytes = new Uint8Array(data.slice(0));
			const text = new TextDecoder().decode(bytes);
			await this.adapter.write(p, text);
			this.binaries.set(p, bytes);
		},
		/** One folder (its parent must exist on disk); a dot-folder too. */
		mkdir: async (p: string) => {
			p = normalizePath(p);
			if (!this.folders.has(p)) await this.createFolder(p);
		},
		write: async (p: string, data: string) => {
			p = normalizePath(p);
			this.binaries.delete(p);
			if (p.split("/").some((seg) => seg.startsWith("."))) {
				this.dotfiles.set(p, String(data));
				return;
			}
			const e = this.files.get(p);
			if (e) e.content = String(data);
			else await this.seed(p, String(data));
		},
	};
	getName(): string {
		return "Test Vault";
	}
	constructor() {
		this.folders.set("/", new TFolder(this, "/"));
	}
	private parentOf(p: string): string {
		const i = p.lastIndexOf("/");
		return i < 0 ? "/" : p.slice(0, i);
	}
	getAbstractFileByPath(p: string): TAbstractFile | null {
		p = normalizePath(p);
		return this.files.get(p)?.file ?? this.folders.get(p) ?? null;
	}
	async createFolder(p: string): Promise<TFolder> {
		p = normalizePath(p);
		if (this.folders.has(p)) throw new Error("Folder already exists.");
		const parentPath = this.parentOf(p);
		if (!this.folders.has(parentPath)) await this.createFolder(parentPath);
		const f = new TFolder(this, p);
		f.parent = this.folders.get(parentPath) ?? null;
		f.parent?.children.push(f);
		this.folders.set(p, f);
		return f;
	}
	async create(p: string, content: string): Promise<TFile> {
		p = normalizePath(p);
		if (this.files.has(p) || this.folders.has(p) || (this.caseInsensitive && this.onDisk(p))) throw new Error("File already exists.");
		const parentPath = this.parentOf(p);
		if (!this.folders.has(parentPath)) throw new Error("Parent folder does not exist: " + parentPath);
		const f = new TFile(this, p);
		f.parent = this.folders.get(parentPath) ?? null;
		f.parent?.children.push(f);
		this.binaries.delete(p);
		this.files.set(p, { file: f, content: String(content) });
		return f;
	}
	async modify(file: TFile, content: string): Promise<void> {
		const e = this.files.get(file.path);
		if (!e) throw new Error("modify: no such file " + file.path);
		this.binaries.delete(file.path);
		e.content = String(content);
	}
	/**
	 * Obsidian's atomic read-modify-write: `fn` gets the note's bytes as they are at this moment and returns the new ones, with
	 * nothing in between. The write goes through `modify` (so a test that watches modify sees it), and only when the bytes
	 * change (what Obsidian does with an unchanged return is not modelled). `beforeProcess`, when a test sets it, runs first:
	 * the moment between a writer's own read and its process call, where a person's typing lands.
	 */
	beforeProcess: ((file: TFile) => Promise<void> | void) | null = null;
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		if (this.beforeProcess) await this.beforeProcess(file);
		const e = this.files.get(file.path);
		if (!e) throw new Error("process: no such file " + file.path);
		const next = fn(e.content);
		if (next !== e.content) await this.modify(file, next);
		return next;
	}
	async read(file: TFile): Promise<string> {
		const e = this.files.get(file.path);
		if (!e) throw new Error("read: no such file " + file.path);
		return e.content;
	}
	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}
	getFiles(): TFile[] {
		return [...this.files.values()].map((e) => e.file);
	}
	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === "md");
	}
	/** Test helper: write a file, creating its parent folders. */
	async seed(p: string, content: string): Promise<TFile> {
		p = normalizePath(p);
		const parentPath = this.parentOf(p);
		if (!this.folders.has(parentPath)) await this.createFolder(parentPath);
		return this.create(p, content);
	}
	/** Test helper: write bytes at a path (a dot-path stays hidden), creating its parent folders. */
	async seedBinary(p: string, bytes: Uint8Array): Promise<void> {
		p = normalizePath(p);
		const parentPath = this.parentOf(p);
		if (!this.folders.has(parentPath)) await this.createFolder(parentPath);
		await this.adapter.writeBinary(p, bytes.slice().buffer);
	}
	/** Test helper: the bytes at a path as readBinary gives them (undefined if absent). */
	async bytesAt(p: string): Promise<Uint8Array | undefined> {
		try {
			return new Uint8Array(await this.adapter.readBinary(p));
		} catch {
			return undefined;
		}
	}
	/** Move a file, or a folder with everything under it (what renameFile does in Obsidian). */
	move(from: string, to: string): void {
		from = normalizePath(from);
		to = normalizePath(to);
		const moved = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : null);
		const reparent = (f: TAbstractFile, p: string) => {
			f.parent?.children.splice(f.parent.children.indexOf(f), 1);
			f.parent = this.folders.get(this.parentOf(p)) ?? null;
			f.parent?.children.push(f);
		};
		if (!this.folders.has(this.parentOf(to))) throw new Error("move: no parent folder for " + to);
		for (const [p, f] of [...this.folders].sort(([a], [b]) => a.length - b.length)) {
			const np = moved(p);
			if (np === null) continue;
			this.folders.delete(p);
			f.path = np;
			f.name = np.split("/").pop() ?? np;
			this.folders.set(np, f);
			reparent(f, np);
		}
		for (const [p, e] of [...this.files]) {
			const np = moved(p);
			if (np === null) continue;
			this.files.delete(p);
			const f = e.file;
			f.path = np;
			f.name = np.split("/").pop() ?? np;
			const dot = f.name.lastIndexOf(".");
			f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
			f.extension = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : "";
			this.files.set(np, e);
			reparent(f, np);
		}
	}
	/**
	 * Delete a file, or an EMPTY folder (Obsidian's delete without `force`
	 * refuses a folder with children; this mock refuses any non-empty folder).
	 * Every call is recorded in `deletes`.
	 */
	deletes: string[] = [];
	async delete(f: TAbstractFile, force?: boolean): Promise<void> {
		this.deletes.push(f.path);
		if (f instanceof TFolder) {
			if (f.children.length > 0 && !force) throw new Error("delete: folder not empty " + f.path);
			if (f.children.length > 0) throw new Error("delete: the mock never force-deletes " + f.path);
			this.folders.delete(f.path);
		} else {
			this.files.delete(f.path);
		}
		f.parent?.children.splice(f.parent.children.indexOf(f), 1);
	}
	/** Test helper: the raw content at a path (undefined if absent). */
	contentAt(p: string): string | undefined {
		return this.files.get(normalizePath(p))?.content;
	}
}

/** Frontmatter as Obsidian sees it: the block must start at byte 0. */
function extractFrontmatter(content: string): Record<string, unknown> | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return null;
	try {
		const v = parseYaml(content.slice(3, end + 1));
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export class MockMetadataCache {
	/** When true, no note has been indexed yet — getFileCache knows nothing. */
	coldCache = false;
	constructor(private vault: MockVault) {}
	getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
		if (this.coldCache) return null;
		const e = this.vault.files.get(file.path);
		if (!e) return null;
		const fm = extractFrontmatter(e.content);
		return fm ? { frontmatter: fm } : {};
	}
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		const target = String(linkpath).trim().toLowerCase().replace(/\.md$/, "");
		if (!target) return null;
		const cands = this.vault.getMarkdownFiles().filter((f) => f.basename.toLowerCase() === target);
		if (cands.length === 0) return null;
		if (cands.length === 1) return cands[0];
		const srcDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
		const same = cands.find((f) => f.parent?.path === srcDir);
		return same ?? [...cands].sort((a, b) => a.path.localeCompare(b.path))[0];
	}
}

export class App {
	vault = new MockVault();
	metadataCache = new MockMetadataCache(this.vault);
	/** Paths opened through workspace.getLeaf().openFile, in order. */
	opened: string[] = [];
	/** Open markdown views (openEditor): what workspace.getLeavesOfType("markdown") lists. */
	leaves: { view: { file: TFile | null; save?: () => Promise<void>; getViewData?: () => string } }[] = [];
	/**
	 * Test helper: an editor open on the note at `path` holding `text` it has not saved yet (null: nothing unsaved), as
	 * Obsidian's editor holds typing for about two seconds before it writes the file. `getViewData()` gives the editor's text
	 * (the held text, else the file's); a test may change `pending` at any moment, as typing does. Its `save()` counts the call,
	 * pushes `save <path>` onto `opts.log`, runs `opts.onSave` when given (a save that hangs or throws), then writes the held text
	 * through vault.modify (once). `opts.withSave: false` makes a view with no save method.
	 */
	openEditor(path: string, text: string | null, opts: { withSave?: boolean; log?: string[]; onSave?: () => Promise<void> } = {}): { saves: number; pending: string | null } {
		const withSave = opts.withSave !== false;
		const log = opts.log;
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error("openEditor: no note at " + path);
		const state = { saves: 0, pending: text };
		const view: { file: TFile | null; save?: () => Promise<void>; getViewData?: () => string } = {
			file,
			getViewData: () => state.pending ?? this.vault.contentAt(file.path) ?? "",
		};
		if (withSave) {
			view.save = async () => {
				state.saves++;
				log?.push(`save ${path}`);
				if (opts.onSave) await opts.onSave();
				if (state.pending !== null && view.file) await this.vault.modify(view.file, state.pending);
				state.pending = null;
			};
		}
		this.leaves.push({ view });
		return state;
	}
	workspace = {
		getActiveFile: (): TFile | null => null,
		getLeavesOfType: (type: string) => (type === "markdown" ? this.leaves : []),
		openLinkText: async (): Promise<void> => {},
		getLeaf: () => ({
			openFile: async (f: TFile): Promise<void> => {
				this.opened.push(f.path);
			},
		}),
	};
	renames: string[] = [];
	/** Paths trashFile was called on, in order. */
	trashed: string[] = [];
	/** When true, renameFile moves what it renames (see the header). */
	realRenames = false;
	fileManager = {
		renameFile: async (f: TAbstractFile, to: string): Promise<void> => {
			this.renames.push(`${f.path} -> ${to}`);
			if (this.realRenames) this.vault.move(f.path, to);
		},
		/** Records the path, then removes it as vault.delete does (an empty folder only). */
		trashFile: async (f: TAbstractFile): Promise<void> => {
			this.trashed.push(f.path);
			await this.vault.delete(f);
			this.vault.deletes.pop();
		},
	};
}

/**
 * A fresh mock app, typed as Obsidian's App for the code under test, plus
 * typed handles on the mock's own vault and cache for the test to drive.
 */
export function makeApp(): { app: ObsidianApp; vault: MockVault; cache: MockMetadataCache; mock: App } {
	const a = new App();
	return { app: a as unknown as ObsidianApp, vault: a.vault, cache: a.metadataCache, mock: a };
}
