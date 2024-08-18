import { App, Modal, Notice } from 'obsidian';

export class WorldNameModal extends Modal {
    onEnter: (value: string) => void;

    constructor(app: App, onEnter: (value: string) => void) {
        super(app);
        this.onEnter = onEnter;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Enter World Name' });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Type the world name here...',
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && input.value.trim() !== '') {
                this.close();
                this.onEnter(input.value.trim());  // Pass trimmed input to ensure no leading/trailing spaces
            }
        });

        input.focus();
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
