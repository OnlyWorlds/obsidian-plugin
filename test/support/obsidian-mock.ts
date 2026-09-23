/**
 * A minimal in-memory stand-in for the `obsidian` module, so tests can drive
 * the REAL Obsidian-facing wiring (vault/element-file.ts writeElement /
 * readElement, Commands/ImportFolderCommand.ts) instead of a model of it.
 *
 * Installed by ./obsidian-shim.ts, which must be imported FIRST.
 *
 * What is emulated, and how faithfully:
 *   - Vault: a path -> content map. create / modify / read / createFolder,
 *     getAbstractFileByPath, getFiles, getMarkdownFiles, adapter.{exists,read,write}.
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
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

const jsYaml = require("js-yaml");
const yaml2 = require("yaml");

let parser: "js-yaml" | "yaml" = "js-yaml";
export function setYamlParser(p: "js-yaml" | "yaml"): void {
	parser = p;
}
export function parseYaml(s: string): any {
	return parser === "yaml" ? yaml2.parse(s) : jsYaml.load(s);
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
	constructor(public vault: any, public path: string) {
		this.name = path.split("/").pop() ?? path;
	}
}
export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	constructor(vault: any, p: string) {
		super(vault, p);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
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
export const __modals: any[] = [];
export class Modal {
	contentEl: any = { empty() {}, createEl() { return { createEl() { return {}; }, style: {} }; } };
	constructor(public app: any) {}
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

class MockVault {
	files = new Map<string, { file: TFile; content: string }>();
	folders = new Map<string, TFolder>();
	dotfiles = new Map<string, string>();
	adapter = {
		exists: async (p: string) => {
			p = normalizePath(p);
			return this.dotfiles.has(p) || this.files.has(p) || this.folders.has(p);
		},
		read: async (p: string) => {
			p = normalizePath(p);
			if (this.dotfiles.has(p)) return this.dotfiles.get(p) as string;
			const e = this.files.get(p);
			if (e) return e.content;
			throw new Error("ENOENT " + p);
		},
		write: async (p: string, data: string) => {
			this.dotfiles.set(normalizePath(p), String(data));
		},
	};
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
		if (this.files.has(p) || this.folders.has(p)) throw new Error("File already exists.");
		const parentPath = this.parentOf(p);
		if (!this.folders.has(parentPath)) throw new Error("Parent folder does not exist: " + parentPath);
		const f = new TFile(this, p);
		f.parent = this.folders.get(parentPath) ?? null;
		f.parent?.children.push(f);
		this.files.set(p, { file: f, content: String(content) });
		return f;
	}
	async modify(file: TFile, content: string): Promise<void> {
		const e = this.files.get(file.path);
		if (!e) throw new Error("modify: no such file " + file.path);
		e.content = String(content);
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
	/** Test helper: the raw content at a path (undefined if absent). */
	contentAt(p: string): string | undefined {
		return this.files.get(normalizePath(p))?.content;
	}
}

/** Frontmatter as Obsidian sees it: the block must start at byte 0. */
function extractFrontmatter(content: string): any {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return null;
	try {
		const v = parseYaml(content.slice(3, end + 1));
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

class MockMetadataCache {
	/** When true, no note has been indexed yet — getFileCache knows nothing. */
	coldCache = false;
	constructor(private vault: MockVault) {}
	getFileCache(file: TFile): any {
		if (this.coldCache) return {};
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
	workspace = { getActiveFile: (): TFile | null => null };
}
