import { App, Modal, Notice, TFolder, normalizePath } from 'obsidian';
import { WorldService } from '../Scripts/WorldService';
import { classifyWorldKey, worldFileApiKey } from '../vault/world-key';

export interface WorldCreationData {
    name: string;
    email: string;
    pin: number;
    /** True = no account: world minted client-side, no server call, sync off until a key is added. */
    localOnly?: boolean;
    /** True = take an EXISTING local-only world online: server world created with
     *  this name, its key written into World.md, then the upload sweep runs. */
    fromLocal?: boolean;
}

export class CreateWorldModal extends Modal {
    onSubmit: (data: WorldCreationData | null) => void;
    private worldService: WorldService;

    constructor(app: App, onSubmit: (data: WorldCreationData | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.worldService = new WorldService(app);
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create New World' });
        
        // World Name Field
        const nameLabel = contentEl.createEl('label', { text: 'World Name' });
        nameLabel.style.display = 'block';
        nameLabel.style.marginTop = '15px';
        nameLabel.style.marginBottom = '4px';
        nameLabel.style.fontWeight = 'bold';
        
        const nameInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: '',
        });
        nameInput.style.width = '100%';
        nameInput.style.marginBottom = '15px';
        
        // Email Field
        const emailLabel = contentEl.createEl('label', { text: 'OnlyWorlds Email Address' });
        emailLabel.style.display = 'block';
        emailLabel.style.marginBottom = '4px';
        emailLabel.style.fontWeight = 'bold';
        
        // Get default email from settings
        const defaultEmail = await this.worldService.getDefaultEmailFromSettings();
        
        const emailInput = contentEl.createEl('input', {
            type: 'email',
            placeholder: '',
        });
        emailInput.style.width = '100%';
        emailInput.style.marginBottom = '15px';
        
        // Pre-fill email if available from settings
        if (defaultEmail) {
            emailInput.value = defaultEmail;
        }
        
        // PIN Field
        const pinLabel = contentEl.createEl('label', { text: 'OnlyWorlds PIN' });
        pinLabel.style.display = 'block';
        pinLabel.style.marginBottom = '4px';
        pinLabel.style.fontWeight = 'bold';
        
        const pinInput = contentEl.createEl('input', {
            type: 'password',
            placeholder: '',
        });
        pinInput.style.width = '100%';
        pinInput.style.marginBottom = '15px';
        
        // Add min/max attributes for 4-digit validation
        pinInput.setAttribute('min', '1000');
        pinInput.setAttribute('max', '9999');
        pinInput.setAttribute('maxlength', '4');
        
        // Prevent entering more than 4 digits
        pinInput.addEventListener('input', (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.value.length > 4) {
                target.value = target.value.slice(0, 4);
            }
        });
        
        // Description
        const description = contentEl.createEl('p', {
            text: 'Email and PIN link the world to your OnlyWorlds account for syncing. ' +
                  'No account? Create a local-only world — everything stays in your vault, ' +
                  'and you can add an API key to World.md later to enable sync.'
        });
        description.style.fontSize = '0.85em';
        description.style.fontStyle = 'italic';
        description.style.marginBottom = '20px';

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

        // Local-Only Button — no account, no server call; name is the only requirement
        const localButton = buttonContainer.createEl('button', { text: 'CREATE LOCAL-ONLY' });
        localButton.style.marginLeft = '8px';
        localButton.addEventListener('click', () => {
            this.validateAndSubmitLocal(nameInput.value);
        });

        // Create Button
        const createButton = buttonContainer.createEl('button', { text: 'CREATE WITH ACCOUNT' });
        createButton.style.marginLeft = '8px';
        createButton.addEventListener('click', () => {
            this.validateAndSubmit(nameInput.value, emailInput.value, pinInput.value);
        });
        
        // Take-a-local-world-online section — only shown when local-only worlds exist.
        const localWorlds = await this.findLocalOnlyWorlds();
        if (localWorlds.length > 0) {
            const divider = contentEl.createEl('hr');
            divider.style.margin = '20px 0 15px 0';

            const publishLabel = contentEl.createEl('label', { text: 'Or take a local world online' });
            publishLabel.style.display = 'block';
            publishLabel.style.marginBottom = '4px';
            publishLabel.style.fontWeight = 'bold';

            const publishDesc = contentEl.createEl('p', {
                text: 'Creates the world on onlyworlds.com under your account (email and PIN above), ' +
                      'links this vault\'s copy to it, and uploads your elements.'
            });
            publishDesc.style.fontSize = '0.85em';
            publishDesc.style.fontStyle = 'italic';
            publishDesc.style.marginBottom = '8px';

            const worldSelect = contentEl.createEl('select');
            worldSelect.style.width = '100%';
            worldSelect.style.marginBottom = '10px';
            for (const w of localWorlds) {
                worldSelect.createEl('option', { text: w, value: w });
            }

            const publishButton = contentEl.createEl('button', { text: 'TAKE ONLINE' });
            publishButton.addEventListener('click', () => {
                this.validateAndSubmitFromLocal(worldSelect.value, emailInput.value, pinInput.value);
            });
        }

        // Handle Enter key press
        nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                emailInput.focus();
            }
        });
        
        emailInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                pinInput.focus();
            }
        });
        
        pinInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.validateAndSubmit(nameInput.value, emailInput.value, pinInput.value);
            }
        });
        
        // Auto-focus the name input
        nameInput.focus();
    }
    
    validateAndSubmit(name: string, email: string, pinStr: string) {
        // Validate name
        if (!name.trim()) {
            new Notice('Please enter a world name');
            return;
        }
        
        // Validate email
        if (!this.isValidEmail(email)) {
            new Notice('Please enter a valid email address');
            return;
        }
        
        // Validate PIN
        const pin = parseInt(pinStr, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }
        
        // All validations passed
        this.close();
        this.onSubmit({
            name: name.trim(),
            email: email.trim(),
            pin: pin
        });
    }
    
    validateAndSubmitLocal(name: string) {
        if (!name.trim()) {
            new Notice('Please enter a world name');
            return;
        }
        this.close();
        // email/pin are unused on the local path; zeroed so the shape stays uniform.
        this.onSubmit({
            name: name.trim(),
            email: '',
            pin: 0,
            localOnly: true
        });
    }

    /** World folders under OnlyWorlds/Worlds/ whose World.md carries the 'local' token. */
    private async findLocalOnlyWorlds(): Promise<string[]> {
        const worldsFolder = this.app.vault.getAbstractFileByPath(normalizePath('OnlyWorlds/Worlds'));
        if (!(worldsFolder instanceof TFolder)) return [];
        const names: string[] = [];
        for (const child of worldsFolder.children) {
            if (!(child instanceof TFolder)) continue;
            const own = await worldFileApiKey(this.app, child.name);
            if (classifyWorldKey(own, undefined).source === 'local-world') {
                names.push(child.name);
            }
        }
        return names.sort();
    }

    validateAndSubmitFromLocal(worldName: string, email: string, pinStr: string) {
        if (!worldName) {
            new Notice('No local world selected');
            return;
        }
        if (!this.isValidEmail(email)) {
            new Notice('Please enter a valid email address (account fields above are used to create the world online)');
            return;
        }
        const pin = parseInt(pinStr, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }
        this.close();
        this.onSubmit({
            name: worldName,
            email: email.trim(),
            pin: pin,
            fromLocal: true
        });
    }

    isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 