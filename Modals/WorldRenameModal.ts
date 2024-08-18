import { App, Modal, DropdownComponent, normalizePath, TFolder, TFile } from 'obsidian';

export class WorldRenameModal extends Modal {
    onRename: (oldWorldName: string, newWorldName: string) => void;

    constructor(app: App, onRename: (oldWorldName: string, newWorldName: string) => void) {
        super(app);
        this.onRename = onRename;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select and Rename World' });
        contentEl.addClass('rename-modal-container');

        const worldFolders = await this.getWorldFolders();
        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.addClass('rename-dropdown');

        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter new world name',
            cls: 'rename-input'
        });

        const renameButton = contentEl.createEl('button', {
            text: 'Rename',
            cls: ['rename-button', 'disabled']
        });

        input.oninput = () => {
            const isValid = input.value.trim().length > 0 && !/[\\/?%*:|"<>]/.test(input.value);
            renameButton.classList.toggle('disabled', !isValid);
        };

        renameButton.onclick = () => {
            if (!renameButton.classList.contains('disabled')) {
                this.close();
                this.onRename(dropdown.getValue(), input.value.trim());
            }
        };

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
