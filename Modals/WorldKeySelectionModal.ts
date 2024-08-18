import { App, Modal, DropdownComponent, normalizePath, TFolder, TFile } from 'obsidian';

export class WorldKeySelectionModal extends Modal {
    onChoose: (worldKey: string, worldFolder: string) => void;
    activeWorldName: string;

    constructor(app: App, onChoose: (worldKey: string, worldFolder: string) => void, activeWorldName: string) {
        super(app);
        this.onChoose = onChoose;
        this.activeWorldName = activeWorldName;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select World and Enter Key' });
        contentEl.addClass('key-selection-modal');

        const worldFolders = await this.getWorldFolders();
        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.addClass('key-selection-dropdown');

        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });
        if (worldFolders.length > 0) {
            dropdown.setValue(this.activeWorldName || worldFolders[0]);
        }

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Please enter 10-digit world key',
            cls: 'key-selection-input'
        });

        const submitButton = contentEl.createEl('button', { text: 'Submit', cls: 'key-selection-submit-button' });
        submitButton.onclick = () => {
            this.close();
            this.onChoose(input.value, dropdown.getValue());
        };

        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                submitButton.click();
            }
        });

        input.focus();
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
