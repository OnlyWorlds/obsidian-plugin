import { App, Modal, Notice } from 'obsidian';

export interface WorldDownloadData {
    apiKey: string;
    /** 4-digit PIN as a string, or "" for a read key (which needs no PIN). */
    pin: string;
}

/** A read-capability key (`ow_r_`) or a demo key (0000000000–0000000009) reads
 *  without a PIN. Detect from the key alone so the modal can drop the PIN wall. */
function isPinlessReadKey(apiKey: string): boolean {
    const k = apiKey.trim();
    if (k.startsWith('ow_r_')) return true;
    return /^000000000\d$/.test(k); // demo range 0000000000–0000000009
}

export class WorldDownloadModal extends Modal {
    onSubmit: (data: WorldDownloadData | null) => void;

    constructor(app: App, onSubmit: (data: WorldDownloadData | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Download World from OnlyWorlds' });
        contentEl.addClass('world-download-modal');

        // Add description text
        const description = contentEl.createEl('p');
        description.innerHTML = `Enter the API key of the world you want to download, and your PIN. Use an ow_ key from your account page, or a classic 10-digit key. A read-only key (ow_r_) needs no PIN.`;
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

        // Live: a read-only key needs no PIN — grey the PIN field out so the UX
        // reads "you don't need this" rather than blocking on a PIN they lack.
        const pinHint = contentEl.createEl('p', { text: '' });
        pinHint.style.fontSize = '0.8em';
        pinHint.style.marginTop = '-14px';
        pinHint.style.marginBottom = '15px';
        pinHint.style.color = 'var(--text-muted)';
        const syncPinState = () => {
            const pinless = isPinlessReadKey(keyInput.value);
            pinInput.disabled = pinless;
            pinInput.style.opacity = pinless ? '0.4' : '1';
            if (pinless) {
                pinInput.value = '';
                pinLabel.style.opacity = '0.4';
                pinHint.setText('Read-only key — no PIN needed.');
            } else {
                pinLabel.style.opacity = '1';
                pinHint.setText('');
            }
        };
        keyInput.addEventListener('input', syncPinState);
        syncPinState();

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
        const importButton = buttonContainer.createEl('button', { text: 'DOWNLOAD' });
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
        if (!apiKey) {
            new Notice('Please enter your API key');
            return;
        }

        // A read-only key needs no PIN — accept a blank PIN and send "".
        if (isPinlessReadKey(apiKey)) {
            this.close();
            this.onSubmit({ apiKey, pin: '' });
            return;
        }

        // Otherwise a valid 4-digit PIN is required (write keys / private worlds).
        const pinTrimmed = pinValue.trim();
        if (!/^\d{4}$/.test(pinTrimmed)) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }

        this.close();
        this.onSubmit({ apiKey, pin: pinTrimmed });
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 