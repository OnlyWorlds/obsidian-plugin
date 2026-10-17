import { App, Modal, Setting } from 'obsidian';
import { applyMobileModal } from './mobile';

/** One element in the list: its type (lowercase singular) and name. */
export interface CreateFirstItem {
    type: string;
    name: string;
}

/**
 * Before a manual Save Element creates a note's link targets on onlyworlds.com,
 * the user sees exactly what would be created, and chooses Create or Cancel
 * (OW Infra #166 row 8; Kael's cold read, blocker 1b). Targets the change feed
 * reported deleted are listed as left out, never created.
 *
 * `choose` settles once: closing the dialog any other way is Cancel.
 */
export class CreateFirstModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        readonly noteLabel: string,
        readonly items: CreateFirstItem[],
        readonly leftOut: CreateFirstItem[],
        private onChoice: (create: boolean) => void,
        /** No stored change-feed cursor: a 404 cannot be told from a delete here (Kael's second read, N3). */
        readonly cannotTell = false,
        /** Why it cannot tell: never downloaded here, or the feed read failed (Kael's third read, 9). */
        readonly cannotTellReason: 'no-cursor' | 'failed' = 'no-cursor'
    ) {
        super(app);
    }

    onOpen() {
        applyMobileModal(this);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Create linked elements first?' });
        contentEl.createEl('p', {
            text: `${this.noteLabel} links to ${this.items.length === 1 ? 'a note that is' : 'notes that are'} not on onlyworlds.com yet. ` +
                'Saving creates these first, for everyone in the world:',
        });
        const list = contentEl.createEl('ul');
        for (const item of this.items) list.createEl('li', { text: itemLabel(item) });
        for (const line of leftOutLines(this.leftOut)) contentEl.createEl('p', { text: line });
        if (this.cannotTell) contentEl.createEl('p', { text: cannotTellLine(this.cannotTellReason) });
        new Setting(contentEl)
            .addButton((b) => b.setButtonText('Create').setCta().onClick(() => this.choose(true)))
            .addButton((b) => b.setButtonText('Cancel').onClick(() => this.choose(false)));
    }

    /** Settle the choice once, and close. */
    choose(create: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.close();
        this.onChoice(create);
    }

    onClose() {
        this.contentEl.empty();
        this.choose(false);
    }
}

/** What the dialog says when this device never downloaded the world (Kael's second read, N3). */
export const CANNOT_TELL_LINE =
    'This device has not downloaded this world, so the plugin cannot tell a note never uploaded ' +
    'from one deleted on onlyworlds.com. Download World first if any of these may have been deleted.';

/** What the plugin says when the change feed could not be read just now. */
export const FEED_FAILED_LINE =
    "The plugin could not read onlyworlds.com's change feed just now, so it cannot tell a note never uploaded " +
    'from one deleted on onlyworlds.com.';

/** The cannot-tell line for its reason. */
export function cannotTellLine(reason: 'no-cursor' | 'failed' | undefined): string {
    return reason === 'failed' ? FEED_FAILED_LINE : CANNOT_TELL_LINE;
}

/** `Location "Vallaki"`. */
export function itemLabel(item: CreateFirstItem): string {
    return `${item.type.charAt(0).toUpperCase()}${item.type.slice(1)} "${item.name}"`;
}

/** One line per target left out because it was deleted on the server. */
export function leftOutLines(leftOut: CreateFirstItem[]): string[] {
    return leftOut.map((i) => `${itemLabel(i)} was deleted on onlyworlds.com and is left out.`);
}
