import { setIcon } from "obsidian";

export type SyncStatus = "idle" | "dirty" | "syncing" | "synced" | "error";

/**
 * Status bar element that reflects the plugin's current sync state.
 *
 * Desktop only — Obsidian's status bar isn't shown on mobile.
 * Mobile gets a ribbon icon (added in Phase 4) that mirrors this state.
 */
export class SyncStatusBar {
	private el: HTMLElement;
	private status: SyncStatus = "idle";
	private lastSync: Date | null = null;
	private lastError: string | null = null;

	constructor(el: HTMLElement) {
		this.el = el;
		this.el.addClass("ow-sync-status");
		this.render();
	}

	setStatus(status: SyncStatus, opts?: { error?: string }): void {
		this.status = status;
		if (status === "synced") {
			this.lastSync = new Date();
			this.lastError = null;
		} else if (status === "error" && opts?.error) {
			this.lastError = opts.error;
		}
		this.render();
	}

	private render(): void {
		this.el.empty();

		const iconEl = this.el.createSpan();
		const label = this.el.createSpan();

		switch (this.status) {
			case "idle":
				setIcon(iconEl, "cloud");
				label.setText("OW");
				this.el.title = this.lastSync
					? `OnlyWorlds — last synced ${this.formatTime(this.lastSync)}`
					: "OnlyWorlds";
				break;
			case "dirty":
				setIcon(iconEl, "cloud-upload");
				label.setText("OW •");
				this.el.title = "OnlyWorlds — unsynced changes";
				break;
			case "syncing":
				setIcon(iconEl, "loader-2");
				iconEl.addClass("ow-spin");
				label.setText("OW…");
				this.el.title = "OnlyWorlds — syncing";
				break;
			case "synced":
				setIcon(iconEl, "cloud-check");
				label.setText("OW");
				this.el.title = `OnlyWorlds — synced at ${this.formatTime(this.lastSync!)}`;
				break;
			case "error":
				setIcon(iconEl, "cloud-alert");
				label.setText("OW !");
				this.el.title = `OnlyWorlds — error: ${this.lastError ?? "unknown"}`;
				break;
		}
	}

	private formatTime(d: Date): string {
		const hh = d.getHours().toString().padStart(2, "0");
		const mm = d.getMinutes().toString().padStart(2, "0");
		return `${hh}:${mm}`;
	}
}
