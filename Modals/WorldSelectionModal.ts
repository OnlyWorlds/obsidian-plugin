import { App, DropdownComponent, Modal, normalizePath, TFile, TFolder } from 'obsidian';

export class WorldSelectionModal extends Modal {
    onChoose: (worldFolder: string) => void;
    activeWorldName: string;

    constructor(app: App, onChoose: (worldFolder: string) => void, activeWorldName: string) {
        super(app);
        this.onChoose = onChoose;
        this.activeWorldName = activeWorldName;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select World' });
        contentEl.addClass('world-selection-modal');

        // Add description text
        const description = contentEl.createEl('p');
        description.innerHTML = `Select the world to copy.`;
        description.style.fontSize = '0.9em';
        description.style.marginBottom = '15px';

        // World Selection Section
        const worldLabel = contentEl.createEl('label', { text: 'World' });
        worldLabel.style.display = 'block';
        worldLabel.style.marginBottom = '4px';
        worldLabel.style.fontWeight = 'bold';
        
        const worldFolders = await this.getWorldFolders();
        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.addClass('world-selection-dropdown');
        dropdown.selectEl.style.width = '100%';
        dropdown.selectEl.style.marginBottom = '15px';

        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });
        if (worldFolders.length > 0) {
            dropdown.setValue(this.activeWorldName || worldFolders[0]);
        }

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
        
        // Validate Button
        const validateButton = buttonContainer.createEl('button', { text: 'VALIDATE' });
        validateButton.style.marginLeft = '8px';
        validateButton.addEventListener('click', () => {
            this.close();
            this.onChoose(dropdown.getValue());
        });

        // Handle Enter key
        dropdown.selectEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                this.close();
                this.onChoose(dropdown.getValue());
            }
        });

        dropdown.selectEl.focus();
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