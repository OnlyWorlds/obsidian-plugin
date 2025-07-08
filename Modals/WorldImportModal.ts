import { App, Modal, Notice } from 'obsidian';

export interface WorldImportData {
    apiKey: string;
    pin: number;
}

export class WorldImportModal extends Modal {
    onSubmit: (data: WorldImportData | null) => void;

    constructor(app: App, onSubmit: (data: WorldImportData | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Import World from OnlyWorlds' });
        contentEl.addClass('world-import-modal');

        // Add description text
        const description = contentEl.createEl('p');
        description.innerHTML = `Enter the API key of the world you want to import and your OnlyWorlds account PIN.`;
        description.style.fontSize = '0.9em';
        description.style.marginBottom = '15px';

        // API Key Input Section
        const keyLabel = contentEl.createEl('label', { text: 'API Key' });
        keyLabel.style.display = 'block';
        keyLabel.style.marginBottom = '4px';
        keyLabel.style.fontWeight = 'bold';
        
        const keyInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: '',
            cls: 'api-key-input'
        });
        keyInput.style.width = '100%';
        keyInput.style.marginBottom = '15px';
        keyInput.setAttribute('maxlength', '10');
        
        // Prevent entering more than 10 digits for API key
        keyInput.addEventListener('input', (e: Event) => {
            const target = e.target as HTMLInputElement;
            // Only allow digits and limit to 10 characters
            target.value = target.value.replace(/\D/g, '').slice(0, 10);
        });

        // PIN Input Section
        const pinLabel = contentEl.createEl('label', { text: 'PIN' });
        pinLabel.style.display = 'block';
        pinLabel.style.marginBottom = '4px';
        pinLabel.style.fontWeight = 'bold';
        
        const pinInput = contentEl.createEl('input', {
            type: 'password',
            placeholder: '',
            cls: 'pin-input'
        });
        pinInput.style.width = '100%';
        pinInput.style.marginBottom = '20px';
        
        // Add min/max attributes for 4-digit validation
        pinInput.setAttribute('min', '1000');
        pinInput.setAttribute('max', '9999');
        pinInput.setAttribute('maxlength', '4');
        
        // Prevent entering more than 4 digits for PIN
        pinInput.addEventListener('input', (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.value.length > 4) {
                target.value = target.value.slice(0, 4);
            }
        });

        // Button Container
        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '20px';
        
        // Cancel Button
        const cancelButton = buttonContainer.createEl('button', { text: 'CANCEL' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
        
        // Import Button
        const importButton = buttonContainer.createEl('button', { text: 'IMPORT' });
        importButton.style.marginLeft = '8px';
        importButton.addEventListener('click', () => {
            this.validateAndSubmit(keyInput.value, pinInput.value);
        });

        // Handle Enter key
        keyInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                pinInput.focus();
            }
        });
        
        pinInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.validateAndSubmit(keyInput.value, pinInput.value);
            }
        });

        // Focus the API key input
        keyInput.focus();
    }

    validateAndSubmit(apiKeyValue: string, pinValue: string) {
        // Validate API key
        const apiKey = apiKeyValue.trim();
        if (!apiKey || apiKey.length !== 10 || !/^\d+$/.test(apiKey)) {
            new Notice('Please enter a valid 10-digit API key');
            return;
        }
        
        // Validate PIN
        const pin = parseInt(pinValue, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }
        
        this.close();
        this.onSubmit({
            apiKey: apiKey,
            pin: pin
        });
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 