import { App, Modal, Setting } from 'obsidian';
import { applyMobileModal } from './mobile';

export type CopyChoice = 'section' | 'property' | 'cancel';

export interface TwinCopies {
    /** The note's name. */
    note: string;
    /** The doubled key (`x_mood`). */
    key: string;
    /** The property as the note holds it. */
    property: unknown;
    /** The section's text. */
    section: string;
}

/**
 * A note holds one field twice with different text: which one to keep. Both are shown whole. Only the person picks;
 * closing the dialog any other way changes nothing. A property that is not text cannot be kept (the field is text), so
 * it is shown and only the section is offered.
 */
export class ChooseCopyModal extends Modal {
    private settled = false;
    readonly offers: CopyChoice[];

    constructor(app: App, readonly copies: TwinCopies, private onChoice: (choice: CopyChoice) => void) {
        super(app);
        this.offers = typeof copies.property === 'string' ? ['section', 'property', 'cancel'] : ['section', 'cancel'];
    }

    onOpen() {
        const { contentEl } = this;
        const { note, key, property, section } = this.copies;
        contentEl.empty();
        contentEl.createEl('h2', { text: `Which ${key} should ${note} keep?` });
        contentEl.createEl('p', { text: 'The note holds this field twice, with different text. The one you do not keep is removed. The whole note is copied to Kept edits/ first.' });
        const show = (title: string, text: string) => {
            contentEl.createEl('h3', { text: title });
            contentEl.createEl('pre', { text: text === '' ? '(empty)' : text, cls: 'ow-copy-text' });
        };
        show('In the section', section);
        show('In the property', typeof property === 'string' ? property : JSON.stringify(property ?? null));
        const row = new Setting(contentEl)
            .addButton((b) => b.setButtonText('Keep the section').onClick(() => this.pick('section')));
        if (this.offers.includes('property')) row.addButton((b) => b.setButtonText('Keep the property').onClick(() => this.pick('property')));
        row.addButton((b) => b.setButtonText('Cancel').onClick(() => this.pick('cancel')));
        applyMobileModal(this);
    }

    /** Settle the choice once, and close. */
    pick(choice: CopyChoice): void {
        if (this.settled) return;
        this.settled = true;
        this.close();
        this.onChoice(choice);
    }

    onClose() {
        this.contentEl.empty();
        this.pick('cancel');
    }
}

/** Open the question and wait for the answer. */
export function chooseCopy(app: App, copies: TwinCopies): Promise<CopyChoice> {
    return new Promise((resolve) => new ChooseCopyModal(app, copies, resolve).open());
}
