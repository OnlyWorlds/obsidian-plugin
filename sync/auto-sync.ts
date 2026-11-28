import { App, TFile, Notice } from "obsidian";
import type OnlyWorldsPlugin from "../main";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { resolveWorldKey } from "../vault/world-key";
import { elementNoteType, readFrontmatter } from "../vault/element-file";
import { isUnderElements, mayBeElementNote, typeOfPlace } from "../vault/category-folder";

/**
 * Auto-sync engine.
 *
 * Watches vault modifications, debounces rapid edits per file, and triggers
 * per-element pushes via SaveElementCommand once typing stops.
 *
 * Per-file debounce: a separate timer per file means edits in file A don't
 * delay syncing file B, and rapid typing in one file just keeps resetting that
 * file's own timer.
 *
 * Infinite-loop guard: when our own code writes back to a file (e.g., to record
 * server-returned timestamps), we set a self-write flag for that path. The
 * matching modify event is then skipped. A flag lives SELF_WRITE_TTL_MS: a
 * write that failed sends no event, and its flag must not swallow the
 * person's next edit of the note.
 */
export class AutoSyncEngine {
	/** How long a self-write mark waits for its modify event; an older mark is no write of ours. */
	static readonly SELF_WRITE_TTL_MS = 30_000;
	private app: App;
	private plugin: OnlyWorldsPlugin;
	/** File -> its pending timer. Keyed by the file itself, not its path: Obsidian keeps the same TFile through a rename, so a note renamed while its timer waits is still the one timer. */
	private timers: Map<TFile, ReturnType<typeof setTimeout>> = new Map();
	/** Path -> when it was marked (now()); one mark swallows one modify event. */
	private selfWritePaths: Map<string, number> = new Map();
	private now: () => number;
	/** Saves running at once: a replace-all over many notes fired one timer each, all at the same moment, every save carrying the PIN. */
	static readonly MAX_PARALLEL_SAVES = 3;
	private activeSaves = 0;
	private waitingSaves: ((skip: boolean) => void)[] = [];

	/** `now` is the clock the self-write marks are aged by (a test's fake clock; Date.now otherwise). */
	constructor(app: App, plugin: OnlyWorldsPlugin, now: () => number = Date.now) {
		this.app = app;
		this.plugin = plugin;
		this.now = now;
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
				if (!mayBeElementNote(file.path)) return;
				const marked = this.selfWritePaths.get(file.path);
				if (marked !== undefined) {
					this.selfWritePaths.delete(file.path);
					// A mark too old for its write (the write failed, no event came) is
					// spent here, and this event is the person's.
					if (this.now() - marked <= AutoSyncEngine.SELF_WRITE_TTL_MS) return;
				}
				if (!this.plugin.settings.autoSync) return;
				// Whether the note is an element's is read from the note (its place, its id and `type`), so a person's own note says nothing.
				void this.isElementFile(file).then((is) => { if (is) this.scheduleSync(file); });
			})
		);
	}

	/**
	 * Schedule (or reschedule) a sync for the given file. Each call clears any
	 * pending timer for this file's path, so rapid edits coalesce into one push.
	 */
	private scheduleSync(file: TFile): void {
		const existing = this.timers.get(file);
		if (existing !== undefined) {
			clearTimeout(existing);
		}
		this.plugin.setSyncStatus("dirty");
		const ms = this.plugin.settings.debounceMs;
		const timer = setTimeout(() => {
			this.timers.delete(file);
			void this.syncFile(file);
		}, ms);
		this.timers.set(file, timer);
	}

	/**
	 * True if file path matches an element note location.
	 */
	private async isElementFile(file: TFile): Promise<boolean> {
		// The plugin's own folders (Elements/<Type>/) are element notes as they always were, a note in the old span format included.
		if (isUnderElements(file.path) && typeOfPlace(file.path)) return true;
		// Anywhere else a note is an element's only with a UUID id in its front matter and a type by place or `type` property:
		// a person's own note is never synced and says nothing.
		const fm = await readFrontmatter(this.app, file);
		return typeof fm?.id === "string" && elementNoteType(file.path, fm) !== null;
	}

	/**
	 * Push a single element file to the API via the existing SaveElementCommand.
	 * Wraps in status-bar transitions and error reporting.
	 */
	private async syncFile(file: TFile): Promise<void> {
		if (this.activeSaves >= AutoSyncEngine.MAX_PARALLEL_SAVES) {
			// Woken to skip when the person cancelled the PIN prompt: they said no for this burst.
			const skip = await new Promise<boolean>((resolve) => this.waitingSaves.push(resolve));
			if (skip) return;
		} else {
			this.activeSaves++;
		}
		try {
			await this.syncFileNow(file);
		} finally {
			// The place passes straight to the next in line, so the count never dips below the cap while any wait.
			const next = this.waitingSaves.shift();
			if (next) next(false);
			else this.activeSaves--;
		}
	}

	private async syncFileNow(file: TFile): Promise<void> {
		// Local-only worlds: skip SILENTLY, and before any workspace side effects.
		// Going through SaveElementCommand would raise a notice on every
		// debounced edit — auto-sync in a local world is simply
		// "there is nothing to do", not an error worth telling the user about.
		const worldMatch = /^OnlyWorlds\/Worlds\/([^/]+)\//i.exec(file.path);
		if (worldMatch) {
			const resolved = await resolveWorldKey(this.app, worldMatch[1], this.plugin.settings.apiKey);
			// A read-key world (ow_r_) the same way: it can never write, so there
			// is nothing to do, and asking for a PIN on every edit was the bug.
			if (resolved.source === "local-world" || resolved.readOnly) {
				this.plugin.setSyncStatus("idle");
				return;
			}
		}
		this.plugin.setSyncStatus("syncing");
		try {
			// Reuse the migrated SDK-based SaveElementCommand. It already handles
			// path parsing, content parsing, API key lookup, PIN caching, SDK call.
			// ★ It saves THIS timer's file, passed in. Swapping the active note and
			// letting the command read it back made every timer in a burst save
			// whichever note was active.
			const cmd = new SaveElementCommand(this.app, this.plugin);
			const result = await cmd.execute(file);
			// Cancel on the PIN prompt: the saves still waiting would each ask again, one prompt after another.
			if (!result.ok && result.pinCancelled) this.waitingSaves.splice(0).forEach((resolve) => resolve(true));
			// The command already showed its Notice; the status must agree with it.
			// A refused save (a 422, no key, the PIN prompt cancelled) ends on
			// error, never on synced.
			if (result.ok) {
				this.plugin.setSyncStatus("synced");
			} else if (result.local) {
				// A note that is never sent (a known-of note):
				// nothing failed and nothing synced.
				this.plugin.setSyncStatus("idle");
			} else {
				this.plugin.setSyncStatus("error", { error: result.reason });
			}
		} catch (error) {
			console.error("Auto-sync error:", error);
			const msg = error instanceof Error ? error.message : "Unknown error";
			this.plugin.setSyncStatus("error", { error: msg });
			new Notice(`OnlyWorlds auto-sync failed: ${msg}`, 8000);
		}
	}

	/**
	 * Call this before writing to a vault file from plugin code, so the resulting
	 * 'modify' event doesn't trigger another sync. The mark holds for
	 * SELF_WRITE_TTL_MS; marking a marked path again renews it, still one event.
	 */
	markSelfWrite(path: string): void {
		this.selfWritePaths.set(path, this.now());
	}
}
