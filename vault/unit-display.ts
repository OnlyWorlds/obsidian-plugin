import { App, MarkdownView, Plugin, TFile, normalizePath } from "obsidian";
import { parseElementPath } from "./element-file";
import { normalizeCategory } from "./element-transform";
import { WorldUnits, parseWorldUnits, unitFor } from "./world-units";

/**
 * World units beside the numbers in an element note's Properties ("182 cm").
 *
 * Display only: the stored frontmatter value stays a plain number and nothing
 * here writes to the vault. Obsidian draws the Properties panel; this marks the
 * value cell of each unit-bearing field with `data-ow-unit` + `ow-has-unit`, and
 * styles.css shows the label after the number. No element is inserted into
 * Obsidian's DOM, so its own re-render of a value cannot fight ours; if a row is
 * rebuilt, the observer below marks it again. When the world's unit is "" the
 * mark is removed and the bare number shows as before.
 *
 * The Properties DOM (`.metadata-property[data-property-key]`,
 * `.metadata-property-value`) is not a public API. Every step is guarded: if
 * Obsidian changes it, the selectors match nothing and the panel is untouched.
 */

const WORLD_FILE_RE = /^OnlyWorlds\/Worlds\/([^/]+)\/World\.md$/i;
const UNIT_ATTR = "data-ow-unit";
const UNIT_CLASS = "ow-has-unit";

export class UnitDisplay {
	private app: App;
	private plugin: Plugin;
	private observers = new Map<HTMLElement, MutationObserver>();
	private timer: number | null = null;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	register(): void {
		const soon = () => this.refreshSoon();
		this.plugin.registerEvent(this.app.workspace.on("file-open", soon));
		this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", soon));
		this.plugin.registerEvent(this.app.workspace.on("layout-change", soon));
		// Frontmatter edits re-render the panel; a World.md edit changes the units.
		this.plugin.registerEvent(this.app.metadataCache.on("changed", soon));
		this.plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && WORLD_FILE_RE.test(file.path)) soon();
			})
		);
		this.app.workspace.onLayoutReady(soon);
		this.plugin.register(() => this.teardown());
	}

	private refreshSoon(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.refresh();
		}, 80);
	}

	private async refresh(): Promise<void> {
		try {
			const unitsByWorld = new Map<string, WorldUnits>();
			const live = new Set<HTMLElement>();
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) continue;
				const root = view.containerEl;
				const info = view.file ? parseElementPath(view.file.path) : null;
				if (!info) {
					this.clear(root);
					continue;
				}
				let units = unitsByWorld.get(info.worldName);
				if (!units) {
					units = await this.readUnits(info.worldName);
					unitsByWorld.set(info.worldName, units);
				}
				const category = normalizeCategory(info.category);
				this.mark(root, category, units);
				for (const panel of Array.from(root.querySelectorAll<HTMLElement>(".metadata-container"))) {
					live.add(panel);
					this.observe(panel, root, category, units);
				}
			}
			// Drop observers on panels that closed or now belong to another note.
			for (const [panel, obs] of this.observers) {
				if (!live.has(panel) || !panel.isConnected) {
					obs.disconnect();
					this.observers.delete(panel);
				}
			}
		} catch (e) {
			console.warn("OnlyWorlds: unit display skipped", e);
		}
	}

	private async readUnits(worldName: string): Promise<WorldUnits> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`));
		if (!(file instanceof TFile)) return {};
		try {
			return parseWorldUnits(await this.app.vault.cachedRead(file));
		} catch {
			return {};
		}
	}

	/** Mark (or unmark) every property value cell under root. Idempotent. */
	private mark(root: HTMLElement, category: string, units: WorldUnits): void {
		for (const row of Array.from(root.querySelectorAll<HTMLElement>(".metadata-property[data-property-key]"))) {
			const cell = row.querySelector<HTMLElement>(".metadata-property-value");
			if (!cell) continue;
			const key = row.getAttribute("data-property-key") ?? "";
			const unit = unitFor(category, key, units);
			if (unit) {
				if (cell.getAttribute(UNIT_ATTR) !== unit) cell.setAttribute(UNIT_ATTR, unit);
				if (!cell.classList.contains(UNIT_CLASS)) cell.classList.add(UNIT_CLASS);
			} else if (cell.hasAttribute(UNIT_ATTR) || cell.classList.contains(UNIT_CLASS)) {
				cell.removeAttribute(UNIT_ATTR);
				cell.classList.remove(UNIT_CLASS);
			}
		}
	}

	private clear(root: HTMLElement): void {
		for (const cell of Array.from(root.querySelectorAll<HTMLElement>(`.${UNIT_CLASS}`))) {
			cell.removeAttribute(UNIT_ATTR);
			cell.classList.remove(UNIT_CLASS);
		}
	}

	/** Re-mark when Obsidian rebuilds rows (childList only: our attribute writes don't trigger it). */
	private observe(panel: HTMLElement, root: HTMLElement, category: string, units: WorldUnits): void {
		this.observers.get(panel)?.disconnect();
		const obs = new MutationObserver(() => this.mark(root, category, units));
		obs.observe(panel, { childList: true, subtree: true });
		this.observers.set(panel, obs);
	}

	private teardown(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		for (const obs of this.observers.values()) obs.disconnect();
		this.observers.clear();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) this.clear(leaf.view.containerEl);
		}
	}
}
