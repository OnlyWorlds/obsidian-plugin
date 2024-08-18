import { App, Modal } from 'obsidian';


export  class WorldKeyModal extends Modal {
    onEnter: (value: string) => void;

    constructor(app: App, onEnter: (value: string) => void) {
        super(app);
        this.onEnter = onEnter;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Enter World Key' });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Please enter 10-digit world key',
            value: '0075037444'
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                this.close();
                this.onEnter(input.value);
            }
        });

        input.focus();
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}