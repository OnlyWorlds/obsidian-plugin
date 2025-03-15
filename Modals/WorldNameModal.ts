import { App, Modal } from 'obsidian';

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
            placeholder: '...',
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && input.value.trim() !== '') {
                this.close();
                this.onEnter(input.value.trim());  // Pass trimmed input to ensure no leading/trailing spaces
            }
        });

        const button = contentEl.createEl('button', { text: 'CREATE' });
        button.style.marginLeft = '8px';
        button.addEventListener('click', () => {
            if (input.value.trim() !== '') {
                this.submit(input.value);
            }
        });

        input.focus();
    }
    submit(value: string) {
        this.close();
        this.onEnter(value.trim());
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
