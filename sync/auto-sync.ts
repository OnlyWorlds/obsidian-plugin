import { App, TFile, Notice } from "obsidian";
import type OnlyWorldsPlugin from "../main";
import { SaveElementCommand } from "../Commands/SaveElementCommand";

/**
 * Auto-sync engine.
 *
 * Watches vault modifications, debounces rapid edits per file, and triggers
 * per-element pushes via SaveElementCommand once typing stops.
 *
 * Per-file debounce: a separate timer per file path means edits in file A don't
 * delay syncing file B, and rapid typing in one file just keeps resetting that
 * file's own timer.
 *
 * Infinite-loop guard: when our own code writes back to a file (e.g., to record
 * server-returned timestamps), we set a self-write flag for that path. The
 * matching modify event is then skipped.
 */
export class AutoSyncEngine {
	private app: App;
	private plugin: OnlyWorldsPlugin;
	private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private selfWritePaths: Set<string> = new Set();

	constructor(app: App, plugin: OnlyWorldsPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * No-op now that we use per-file timers — kept for settings-tab API compatibility.
	 * The new debounceMs is read live on each scheduled timer.
	 */
	rebuildDebouncer(): void {
		// per-file timers read this.plugin.settings.debounceMs at schedule time;
		// nothing to rebuild
	}

	/**
	 * Register vault event listeners. Call once during plugin onload.
	 */
	registerListeners(): void {
		this.plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				if (!this.isElementFile(file)) return;
				if (this.selfWritePaths.has(file.path)) {
					this.selfWritePaths.delete(file.path);
					return;
				}
				if (!this.plugin.settings.autoSync) return;
				this.scheduleSync(file);
			})
		);
	}

	/**
	 * Schedule (or reschedule) a sync for the given file. Each call clears any
	 * pending timer for this file's path, so rapid edits coalesce into one push.
	 */
	private scheduleSync(file: TFile): void {
		const existing = this.timers.get(file.path);
		if (existing !== undefined) {
			clearTimeout(existing);
		}
		this.plugin.setSyncStatus("dirty");
		const ms = this.plugin.settings.debounceMs;
		const timer = setTimeout(() => {
			this.timers.delete(file.path);
			void this.syncFile(file);
		}, ms);
		this.timers.set(file.path, timer);
	}

	/**
	 * True if file path matches an element note location.
	 */
	private isElementFile(file: TFile): boolean {
		return /^OnlyWorlds\/Worlds\/[^/]+\/Elements\/[^/]+\/.+\.md$/i.test(file.path);
	}

	/**
	 * Push a single element file to the API via the existing SaveElementCommand.
	 * Wraps in status-bar transitions and error reporting.
	 */
	private async syncFile(file: TFile): Promise<void> {
		this.plugin.setSyncStatus("syncing");
		try {
			// Reuse the migrated SDK-based SaveElementCommand. It already handles
			// path parsing, content parsing, API key lookup, PIN caching, SDK call.
			const cmd = new SaveElementCommand(this.app, this.plugin);
			// Set the active file context so SaveElementCommand picks it up.
			// (SaveElementCommand reads from workspace.getActiveFile(), so we briefly
			// open the file if not already active. Cheap, no flash.)
			const wasActive = this.app.workspace.getActiveFile()?.path === file.path;
			if (!wasActive) {
				await this.app.workspace.openLinkText(file.path, "", false);
			}
			await cmd.execute();
			this.plugin.setSyncStatus("synced");
		} catch (error) {
			console.error("Auto-sync error:", error);
			const msg = error instanceof Error ? error.message : "Unknown error";
			this.plugin.setSyncStatus("error", { error: msg });
			new Notice(`OnlyWorlds auto-sync failed: ${msg}`, 8000);
		}
	}

	/**
	 * Call this before writing to a vault file from plugin code, so the resulting
	 * 'modify' event doesn't trigger another sync.
	 */
	markSelfWrite(path: string): void {
		this.selfWritePaths.add(path);
	}
}
