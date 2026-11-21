import { App } from "obsidian";
import { PinInputModal } from "../Modals/PinInputModal";

/**
 * PIN resolution chain.
 *
 * Resolution order:
 *   1. Persisted PIN from settings (if user set it in the settings tab).
 *   2. Session-cached PIN (prompted on first need, held in memory).
 *   3. Prompt via PinInputModal.
 *
 * Returns null only if user cancels the modal prompt.
 */
export class PinCache {
	private pin: string | null = null;
	/**
	 * PINs keel refused: neither the saved setting nor the session copy of one is handed out again.
	 * A set, not the last one: a saved PIN refused first and a typed one refused after it must both stay out.
	 */
	private refused = new Set<string>();
	/** The prompt in front of the person, shared by every save that asks while it is open. */
	private asking: Promise<string | null> | null = null;
	private app: App;
	private getPersistedPin: () => string;

	constructor(app: App, getPersistedPin: () => string = () => "") {
		this.app = app;
		this.getPersistedPin = getPersistedPin;
	}

	/**
	 * Get a usable PIN. Tries persisted setting first, then session cache, then prompts.
	 */
	async get(): Promise<string | null> {
		const persisted = this.usablePersisted();
		if (persisted) {
			return persisted;
		}
		if (this.pin) {
			return this.pin;
		}
		// One prompt for all of them: forty auto-sync saves meeting a refused PIN at once
		// opened forty prompts, one on top of another.
		if (this.asking) return this.asking;
		this.asking = new Promise((resolve) => {
			new PinInputModal(this.app, (pin: string | null) => {
				if (pin) {
					this.pin = pin;
					this.refused.delete(pin); // typed by the person just now: theirs to try
				}
				this.asking = null;
				resolve(pin);
			}).open();
		});
		return this.asking;
	}

	/** The PIN already in hand (the setting, else this session's), never prompting; null when there is none. */
	peek(): string | null {
		return this.usablePersisted() ?? this.pin;
	}

	/** The saved PIN, unless keel refused exactly that one (a changed setting is a new PIN and is tried). */
	private usablePersisted(): string | null {
		const persisted = this.getPersistedPin();
		return persisted && persisted.length === 4 && !this.refused.has(persisted) ? persisted : null;
	}

	/**
	 * keel refused this PIN (a 401 naming API-Pin). It is not sent again by itself:
	 * the session copy goes, a saved copy is skipped until the setting changes, and
	 * the next save asks the person once.
	 */
	refuse(pin: string): void {
		this.refused.add(pin);
		if (this.pin === pin) this.pin = null;
	}

	/**
	 * Clear the in-memory session cache. Does not clear the persisted setting.
	 */
	clear(): void {
		this.pin = null;
	}
}
