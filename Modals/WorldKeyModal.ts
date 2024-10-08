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
            placeholder: 'Please enter 10-digit key', 
        });

        const button = contentEl.createEl('button', { text: 'IMPORT' });
        button.style.marginLeft = '8px';
        button.addEventListener('click', () => {
            if (input.value.trim() !== '') {
                this.submit(input.value);
            }
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                this.close();
                this.onEnter(input.value);
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