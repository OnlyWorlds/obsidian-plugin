import { App, Modal, Notice } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';
import { signedInLabel, type AccountWorld } from '../account/account-api';
import { renderAccountWorlds } from './AccountWorldList';

export interface WorldDownloadData {
    apiKey: string;
    /** 4-digit PIN as a string, or "" for a read key (which needs no PIN). */
    pin: string;
}

/** The signed-in account's worlds, offered beside the key-and-PIN form (OW Infra #358). */
export interface WorldDownloadAccount {
    username: string;
    loadWorlds: () => Promise<AccountWorld[]>;
    onPick: (world: AccountWorld) => void;
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
    private account: WorldDownloadAccount | null;

    constructor(app: App, onSubmit: (data: WorldDownloadData | null) => void, account?: WorldDownloadAccount) {
        super(app);
        this.onSubmit = onSubmit;
        this.account = account ?? null;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Download world from OnlyWorlds' });
        contentEl.addClass('world-download-modal');

        // Signed in: the account's worlds first; the key-and-PIN form below is unchanged.
        if (this.account) {
            const account = this.account;
            const section = contentEl.createDiv({ cls: 'ow-account-section' });
            section.createEl('label', { text: 'From your account', cls: 'ow-account-label' });
            section.createEl('p', {
                text: `${signedInLabel(account.username)}. Pick a world: this vault gets its own key for it, named for the vault.`,
                cls: 'ow-account-hint',
            });
            const list = section.createDiv();
            list.createEl('p', { text: 'Loading your worlds…', cls: 'ow-account-hint' });
            account.loadWorlds().then(
                (worlds) => renderAccountWorlds(list, worlds, (w) => {
                    this.close();
                    account.onPick(w);
                }),
                (e: unknown) => {
                    list.empty();
                    list.createEl('p', { text: e instanceof Error ? e.message : 'Your worlds could not be read.', cls: 'ow-account-hint' });
                }
            );
            contentEl.createEl('hr', { cls: 'ow-account-divider' });
            contentEl.createEl('label', { text: 'Or with a key', cls: 'ow-account-label' });
        }

        // Add description text
        const description = contentEl.createEl('p', {
            text: "Paste a write key or a read key from the world's Access page. A read key needs no PIN.",
        });
        description.style.fontSize = '0.9em';
        description.style.marginBottom = '15px';

        // API Key Input Section
        const keyLabel = contentEl.createEl('label', { text: 'API key' });
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
        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
        
        // Import Button
        const importButton = buttonContainer.createEl('button', { text: 'Download' });
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
        if (!suppressAutofocus()) keyInput.focus();
        applyMobileModal(this);
    }

    validateAndSubmit(apiKeyValue: string, pinValue: string) {
        // Validate API key
        const apiKey = apiKeyValue.trim();
        if (!apiKey) {
            new Notice('API key is required');
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
            new Notice('Enter a 4-digit PIN');
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