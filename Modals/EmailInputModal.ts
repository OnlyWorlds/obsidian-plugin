import { App, Modal, Notice } from 'obsidian';

export class EmailInputModal extends Modal {
    onSubmit: (value: string) => void;
    worldName: string;

    constructor(app: App, worldName: string, onSubmit: (value: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.worldName = worldName;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Enter Email for World Creation' });
        
        const description = contentEl.createEl('p');
        description.innerHTML = `To create a new world called <strong>${this.worldName}</strong>, we need to register it with OnlyWorlds. 
        Please enter your email address. This will be used to verify ownership of the world.`;

        const input = contentEl.createEl('input', {
            type: 'email',
            placeholder: 'Enter your email address...',
        });

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && this.isValidEmail(input.value)) {
                this.submit(input.value);
            }
        });

        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.marginTop = '20px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';

        const cancelButton = buttonContainer.createEl('button', { text: 'CANCEL' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(""); // Empty string indicates cancellation
        });

        const createButton = buttonContainer.createEl('button', { text: 'CREATE' });
        createButton.style.marginLeft = '8px';
        createButton.addEventListener('click', () => {
            if (this.isValidEmail(input.value)) {
                this.submit(input.value);
            } else {
                new Notice('Please enter a valid email address');
            }
        });

        input.focus();
    }

    isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    submit(value: string) {
        this.close();
        this.onSubmit(value.trim());
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 