import { App, Modal, Setting } from 'obsidian';
import { applyMobileModal } from './mobile';

/** One element in the list: its type (lowercase singular) and name. */
export interface CreateFirstItem {
    type: string;
    name: string;
    /** Left out because the world's owner hid it, not because it was deleted. */
    hidden?: boolean;
    /** Left out because a role reset took it out of this reader's view (Kael's read, 2026-10-20). */
    leftView?: boolean;
}

/**
 * Before a manual Save Element creates a note's link targets on onlyworlds.com,
 * the user sees exactly what would be created, and chooses Create or Cancel
 * (Kael's cold read, blocker 1b). Targets the change feed
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
        /** The plugin cannot tell a 404 from a delete here: the feed read failed, the server was restored, or keel asks for a re-read. */
        readonly cannotTell = false,
        /** Why it cannot tell (Kael's third read, 9). */
        readonly cannotTellReason: CannotTellReason = 'failed'
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

/** What the plugin says when the change feed could not be read just now. */
export const FEED_FAILED_LINE =
    "The plugin could not read onlyworlds.com's change feed just now, so it cannot tell a note never uploaded " +
    'from one deleted on onlyworlds.com.';

/** What the plugin says when the server is behind this device's last Download (Kael's third read, 4). */
export const REWOUND_LINE =
    'onlyworlds.com was restored from a backup since this device last downloaded the world, so the plugin ' +
    'cannot tell a note never uploaded from one deleted there. Download world first.';

/** What the plugin says when onlyworlds.com asks this device to re-read the world (keel's 409 resync_required). */
export const RESYNC_LINE =
    'onlyworlds.com asks this device to read the world again, so the plugin cannot tell a note never uploaded ' +
    'from one deleted there: Download world to catch up.';

/**
 * Why the plugin cannot tell: a failed feed read, a restored server, or keel's
 * resync_required. A device with no stored cursor reads the feed from the start
 * (3b68635), so "never downloaded here" is no longer a reason.
 */
export type CannotTellReason = 'failed' | 'rewound' | 'resync';

/** The cannot-tell line for its reason. */
export function cannotTellLine(reason: CannotTellReason | undefined): string {
    if (reason === 'rewound') return REWOUND_LINE;
    if (reason === 'resync') return RESYNC_LINE;
    return FEED_FAILED_LINE;
}

/** `Location "Vallaki"`. */
export function itemLabel(item: CreateFirstItem): string {
    return `${item.type.charAt(0).toUpperCase()}${item.type.slice(1)} "${item.name}"`;
}

/** One line per target left out because it was deleted on the server, or hidden by the world's owner. */
export function leftOutLines(leftOut: CreateFirstItem[]): string[] {
    return leftOut.map((i) =>
        i.hidden
            ? `${itemLabel(i)} is hidden by the world's owner and is left out.`
            : i.leftView
              ? `${itemLabel(i)} is no longer in your view and is left out.`
              : `${itemLabel(i)} was deleted on onlyworlds.com and is left out.`
    );
}
