import { App, Modal, Notice } from 'obsidian';

export class WorldPasteModal extends Modal {
    onSubmit: (jsonData: any) => void;

    constructor(app: App, onSubmit: (jsonData: any) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create World From World Data' });

        // Create a textarea element with specific class
        let inputArea = contentEl.createEl('textarea', {
            placeholder: 'Insert JSON data here...',
            cls: ['world-paste-textarea']
        });

        // Create a submit button with specific class
        const submitButton = contentEl.createEl('button', {
            text: 'Submit',
            cls: ['world-paste-submit-button', 'disabled']
        });

        inputArea.addEventListener('input', (e) => {
            const value = (e.target as HTMLTextAreaElement).value;
            if (!value) {
                inputArea.classList.add('invalid');
                inputArea.classList.remove('valid');
                submitButton.classList.add('disabled');
                return;
            }
            if (this.isValidJSON(value)) {
                inputArea.classList.add('valid');
                inputArea.classList.remove('invalid');
                submitButton.classList.remove('disabled');
            } else {
                inputArea.classList.add('invalid');
                inputArea.classList.remove('valid');
                submitButton.classList.add('disabled');
            }
        });

        submitButton.onclick = () => {
            if (!submitButton.classList.contains('disabled')) {
                this.onSubmit(JSON.parse(inputArea.value));
                this.close();
            }
        };
    }

    isValidJSON(str: string): boolean {
        try {
            JSON.parse(str);
            return true; // Simplified for brevity, implement actual validation logic as needed
        } catch (e) {
            return false;
        }
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
