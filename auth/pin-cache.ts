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
		const persisted = this.getPersistedPin();
		if (persisted && persisted.length === 4) {
			return persisted;
		}
		if (this.pin) {
			return this.pin;
		}
		return new Promise((resolve) => {
			new PinInputModal(this.app, (pin: string | null) => {
				if (pin) {
					this.pin = pin;
				}
				resolve(pin);
			}).open();
		});
	}

	/**
	 * Clear the in-memory session cache. Does not clear the persisted setting.
	 */
	clear(): void {
		this.pin = null;
	}
}
