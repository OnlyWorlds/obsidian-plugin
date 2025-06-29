import { App, DropdownComponent, Modal, normalizePath, Notice, TFile, TFolder } from 'obsidian';

export class WorldPinSelectionModal extends Modal {
    onChoose: (pin: number, worldFolder: string) => void;
    activeWorldName: string;

    constructor(app: App, onChoose: (pin: number, worldFolder: string) => void, activeWorldName: string) {
        super(app);
        this.onChoose = onChoose;
        this.activeWorldName = activeWorldName;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select World and Enter PIN' });
        contentEl.addClass('pin-selection-modal');

        // Add description text
        const description = contentEl.createEl('p');
        description.innerHTML = `Select the world to export, then enter your OnlyWorlds PIN to verify permission.`;
        description.style.fontSize = '0.9em';
        description.style.marginBottom = '15px';

        // World Selection Section
        const worldLabel = contentEl.createEl('label', { text: 'World' });
        worldLabel.style.display = 'block';
        worldLabel.style.marginBottom = '4px';
        worldLabel.style.fontWeight = 'bold';
        
        const worldFolders = await this.getWorldFolders();
        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.addClass('pin-selection-dropdown');
        dropdown.selectEl.style.width = '100%';
        dropdown.selectEl.style.marginBottom = '15px';

        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });
        if (worldFolders.length > 0) {
            dropdown.setValue(this.activeWorldName || worldFolders[0]);
        }

        // PIN Input Section
        const pinLabel = contentEl.createEl('label', { text: 'PIN' });
        pinLabel.style.display = 'block';
        pinLabel.style.marginBottom = '4px';
        pinLabel.style.fontWeight = 'bold';
        
        const input = contentEl.createEl('input', {
            type: 'password',
            placeholder: '',
            cls: 'pin-selection-input'
        });
        input.style.width = '100%';
        input.style.marginBottom = '20px';
        
        // Add min/max attributes for 4-digit validation
        input.setAttribute('min', '1000');
        input.setAttribute('max', '9999');
        input.setAttribute('maxlength', '4');
        
        // Prevent entering more than 4 digits
        input.addEventListener('input', (e: Event) => {
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
        });
        
        // Export Button
        const exportButton = buttonContainer.createEl('button', { text: 'VALIDATE' });
        exportButton.style.marginLeft = '8px';
        exportButton.addEventListener('click', () => {
            this.validateAndSubmit(input.value, dropdown.getValue());
        });

        // Handle Enter key
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                this.validateAndSubmit(input.value, dropdown.getValue());
            }
        });

        input.focus();
    }

    validateAndSubmit(pinValue: string, worldFolder: string) {
        const pin = parseInt(pinValue, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }
        this.close();
        this.onChoose(pin, worldFolder);
    }

    async getWorldFolders(): Promise<string[]> { 
        const worldsPath = normalizePath('OnlyWorlds/Worlds/');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);

        if (!(worldsFolder instanceof TFolder)) {
            console.error('Expected worlds folder not found.');
            return [];  
        }

        return worldsFolder.children
            .filter(child => child instanceof TFolder && child.children.some(file => file instanceof TFile && file.name === "World.md"))
            .map(folder => folder.name);
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 