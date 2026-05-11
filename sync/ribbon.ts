import { App, Menu, Notice, setIcon } from "obsidian";
import type OnlyWorldsPlugin from "../main";
import { SyncStatus } from "./status-bar";

/**
 * Ribbon icon that mirrors the sync status. Always visible on both desktop and mobile.
 * Provides the primary sync surface on mobile (no status bar there).
 *
 * Click action: opens a small menu with Sync now, Open settings, and About.
 * (No accidental syncs from a stray ribbon click.)
 */
export class SyncRibbon {
	private el: HTMLElement | null = null;
	private plugin: OnlyWorldsPlugin;
	private app: App;

	constructor(app: App, plugin: OnlyWorldsPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	register(): void {
		this.el = this.plugin.addRibbonIcon("cloud", "OnlyWorlds sync", (evt: MouseEvent) => this.onClick(evt));
		this.el.addClass("ow-ribbon");
		this.setStatus("idle");
	}

	setStatus(status: SyncStatus): void {
		if (!this.el) return;
		const iconName = (() => {
			switch (status) {
				case "syncing": return "loader-2";
				case "synced": return "cloud-check";
				case "dirty": return "cloud-upload";
				case "error": return "cloud-alert";
				default: return "cloud";
			}
		})();
		setIcon(this.el, iconName);
		if (status === "syncing") {
			this.el.addClass("ow-spin");
		} else {
			this.el.removeClass("ow-spin");
		}
		this.el.setAttribute("aria-label", `OnlyWorlds — ${status}`);
	}

	private onClick(evt: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Sync current note")
				.setIcon("cloud-upload")
				.onClick(() => {
					const activeFile = this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice("Open an OnlyWorlds element note first.");
						return;
					}
					// Trigger the registered command by id
					(this.app as unknown as { commands: { executeCommandById: (id: string) => void } })
						.commands.executeCommandById("onlyworlds-builder:save-element");
				})
		);

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Open OnlyWorlds settings")
				.setIcon("settings")
				.onClick(() => {
					(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
					(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById(
						"onlyworlds-builder"
					);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("About OnlyWorlds")
				.setIcon("info")
				.onClick(() => {
					window.open("https://www.onlyworlds.com/about", "_blank");
				})
		);

		menu.showAtMouseEvent(evt);
	}
}
