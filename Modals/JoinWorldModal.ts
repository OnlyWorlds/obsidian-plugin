import { App, Modal } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';

/** "Join a world with a link": one field for the link or the bare code. */
export class JoinLinkModal extends Modal {
    constructor(app: App, private onSubmit: (input: string) => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Join a world with a link' });
        contentEl.createEl('p', {
            text: 'Paste the invite link (https://www.onlyworlds.com/join#ow_j_…) or its code.',
            cls: 'ow-account-hint',
        });
        const input = contentEl.createEl('input', { type: 'text', placeholder: 'https://www.onlyworlds.com/join#ow_j_…' });
        input.addClass('ow-join-input');
        const submit = () => {
            const v = input.value.trim();
            if (!v) return;
            this.close();
            this.onSubmit(v);
        };
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
        });
        const row = contentEl.createDiv({ cls: 'ow-join-buttons' });
        const cancel = row.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.close());
        const join = row.createEl('button', { text: 'Next' });
        join.addEventListener('click', submit);
        if (!suppressAutofocus()) input.focus();
        applyMobileModal(this);
    }

    onClose() {
        this.contentEl.empty();
    }
}

/** The preview, said before anything is spent or made: who invites, to which world, as what. */
export class JoinConfirmModal extends Modal {
    private answered = false;

    constructor(app: App, private words: string, private detail: string, private onAnswer: (yes: boolean) => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Join this world?' });
        contentEl.createEl('p', { text: this.words });
        if (this.detail) contentEl.createEl('p', { text: this.detail, cls: 'ow-account-hint' });
        const row = contentEl.createDiv({ cls: 'ow-join-buttons' });
        const cancel = row.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.answer(false));
        const join = row.createEl('button', { text: 'Join' });
        join.addEventListener('click', () => this.answer(true));
        applyMobileModal(this);
    }

    private answer(yes: boolean) {
        if (this.answered) return;
        this.answered = true;
        this.close();
        this.onAnswer(yes);
    }

    onClose() {
        this.contentEl.empty();
        // Closed any other way (Escape, the x): a no.
        if (!this.answered) {
            this.answered = true;
            this.onAnswer(false);
        }
    }
}
