import { App, Modal, Setting } from 'obsidian';
import { applyMobileModal } from './mobile';

/**
 * A yes/no question with a few lines of context: "deleted on onlyworlds.com:
 * create it again?" (Kael's second read, N1 and N4). `choose` settles once;
 * closing the dialog any other way is the no.
 */
export class ConfirmModal extends Modal {
    private settled = false;

    constructor(
        app: App,
        readonly title: string,
        readonly lines: string[],
        readonly yesText: string,
        private onChoice: (yes: boolean) => void,
        readonly noText = 'Cancel'
    ) {
        super(app);
    }

    onOpen() {
        applyMobileModal(this);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.title });
        for (const line of this.lines) contentEl.createEl('p', { text: line });
        new Setting(contentEl)
            .addButton((b) => b.setButtonText(this.yesText).setCta().onClick(() => this.choose(true)))
            .addButton((b) => b.setButtonText(this.noText).onClick(() => this.choose(false)));
    }

    /** Settle the choice once, and close. */
    choose(yes: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.close();
        this.onChoice(yes);
    }

    onClose() {
        this.contentEl.empty();
        this.choose(false);
    }
}

/** Open a ConfirmModal and wait for the answer. */
export function confirm(app: App, title: string, lines: string[], yesText: string, noText?: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, lines, yesText, resolve, noText).open());
}
