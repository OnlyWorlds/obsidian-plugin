import { App, Modal, Notice, TFolder, normalizePath } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';
import { classifyWorldKey, worldFileApiKey } from '../vault/world-key';
import { CREATE_SIGN_IN_BELOW, CREATE_SIGN_IN_FIRST, signedInLabel } from '../account/account-api';

export interface WorldCreationData {
    name: string;
    pin: number;
    /** True = no account: world minted client-side, no server call, sync off until a key is added. */
    localOnly?: boolean;
    /** True = take an EXISTING local-only world online: server world created with
     *  this name, its key written into World.md, then the upload sweep runs. */
    fromLocal?: boolean;
}

export class CreateWorldModal extends Modal {
    onSubmit: (data: WorldCreationData | null) => void;
    /**
     * Signed in: the world goes under this account. Signed out,
     * only a local-only world can be made here: the online create goes through
     * the account, so the modal says to sign in first.
     */
    private account: { username: string } | null;
    /**
     * Signed out: Create with account opens the Sign in dialog over this one;
     * once signed in, this dialog draws itself again, signed in, the typed
     * name kept.
     */
    private signIn: ((then: (username: string) => void) => void) | null;
    private nameInput: HTMLInputElement | null = null;
    private keptName = '';
    private localWorldSelect: HTMLSelectElement | null = null;
    private keptLocalWorld = '';

    constructor(
        app: App,
        onSubmit: (data: WorldCreationData | null) => void,
        account?: { username: string },
        signIn?: (then: (username: string) => void) => void
    ) {
        super(app);
        this.onSubmit = onSubmit;
        this.account = account ?? null;
        this.signIn = signIn ?? null;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create new world' });
        
        // World Name Field
        const nameLabel = contentEl.createEl('label', { text: 'World name' });
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
        nameInput.value = this.keptName;
        this.nameInput = nameInput;

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
        // Signed out: no online create here, so no PIN to give.
        if (!this.account) {
            pinLabel.hide();
            pinInput.hide();
        }

        // Description
        const description = contentEl.createEl('p', {
            text: this.account
                ? `${signedInLabel(this.account.username)}: the world is created under that account. ` +
                  'The PIN is your account PIN; an account without one yet takes this one. ' +
                  'Or create a local-only world: everything stays in your vault.'
                : this.signIn ? CREATE_SIGN_IN_BELOW : CREATE_SIGN_IN_FIRST
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
        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });

        // Local-Only Button — no account, no server call; name is the only requirement
        const localButton = buttonContainer.createEl('button', { text: 'Create local-only' });
        localButton.style.marginLeft = '8px';
        localButton.addEventListener('click', () => {
            this.validateAndSubmitLocal(nameInput.value);
        });

        // Create Button
        const createButton = buttonContainer.createEl('button', { text: 'Create with account' });
        createButton.style.marginLeft = '8px';
        createButton.addEventListener('click', () => {
            this.validateAndSubmit(nameInput.value, pinInput.value);
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
                text: this.account
                    ? 'Creates the world on onlyworlds.com under your account (the PIN above), ' +
                      'links this vault\'s copy to it, and uploads your elements.'
                    : 'Creates the world on onlyworlds.com under your account, links this vault\'s copy to it, ' +
                      'and uploads your elements. ' +
                      (this.signIn ? 'Take online signs you in first.' : 'Sign in first (Settings, OnlyWorlds account).')
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
            if (localWorlds.includes(this.keptLocalWorld)) worldSelect.value = this.keptLocalWorld;
            this.localWorldSelect = worldSelect;

            const publishButton = contentEl.createEl('button', { text: 'Take online' });
            publishButton.addEventListener('click', () => {
                this.validateAndSubmitFromLocal(worldSelect.value, pinInput.value);
            });
        }

        // Handle Enter key press
        nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (this.account) pinInput.focus();
            }
        });

        pinInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.validateAndSubmit(nameInput.value, pinInput.value);
            }
        });
        
        // Auto-focus the name input
        if (!suppressAutofocus()) nameInput.focus();
        applyMobileModal(this);
    }
    
    validateAndSubmit(name: string, pinStr: string) {
        // Signed out, with sign-in on offer: sign in first, then back here.
        if (!this.account && this.signIn) {
            this.signIn((username) => this.redrawSignedIn(username));
            return;
        }

        // Validate name
        if (!name.trim()) {
            new Notice('World name is required');
            return;
        }

        // Signed out: the online create goes through the account.
        if (!this.account) {
            new Notice(CREATE_SIGN_IN_FIRST, 10000);
            return;
        }

        // Validate PIN
        const pin = parseInt(pinStr, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Enter a 4-digit PIN (1000 to 9999)');
            return;
        }
        
        // All validations passed
        this.close();
        this.onSubmit({
            name: name.trim(),
            pin: pin
        });
    }
    
    /** After a sign-in from this dialog: draw it again under the account, the typed name kept. */
    private redrawSignedIn(username: string) {
        this.keptName = this.nameInput?.value ?? '';
        this.keptLocalWorld = this.localWorldSelect?.value ?? '';
        this.localWorldSelect = null;
        this.account = { username };
        this.contentEl.empty();
        void this.onOpen();
    }

    validateAndSubmitLocal(name: string) {
        if (!name.trim()) {
            new Notice('World name is required');
            return;
        }
        this.close();
        // The PIN is unused on the local path; zeroed so the shape stays uniform.
        this.onSubmit({
            name: name.trim(),
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

    validateAndSubmitFromLocal(worldName: string, pinStr: string) {
        if (!worldName) {
            new Notice('No local world selected');
            return;
        }
        // Signed out, with sign-in on offer: sign in first, then back here.
        if (!this.account && this.signIn) {
            this.signIn((username) => this.redrawSignedIn(username));
            return;
        }
        if (!this.account) {
            new Notice(CREATE_SIGN_IN_FIRST, 10000);
            return;
        }
        const pin = parseInt(pinStr, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Enter a 4-digit PIN (1000 to 9999)');
            return;
        }
        this.close();
        this.onSubmit({
            name: worldName,
            pin: pin,
            fromLocal: true
        });
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 