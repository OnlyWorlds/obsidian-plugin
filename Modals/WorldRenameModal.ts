import { App, Modal, DropdownComponent, Notice, normalizePath, TFolder, TFile } from 'obsidian';

export class WorldRenameModal extends Modal {
    onRename: (oldWorldName: string, newWorldName: string) => void;

    constructor(app: App, onRename: (oldWorldName: string, newWorldName: string) => void) {
        super(app);
        this.onRename = onRename;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Select and Rename World' });

        contentEl.style.display = 'flex';
        contentEl.style.flexDirection = 'column';
        contentEl.style.gap = '10px';

        const worldFolders = await this.getWorldFolders();
        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.style.width = '100%';
        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter new world name',
            attr: { autocomplete: 'off' }
        });
        input.style.width = '100%';

        const renameButton = contentEl.createEl('button', { text: 'Rename' });
        renameButton.disabled = true; // Initially disabled
        input.oninput = () => {
            const isValid = input.value.trim().length > 0 && !/[\\/?%*:|"<>]/.test(input.value);
            renameButton.disabled = !isValid;
        };

        renameButton.onclick = () => {
            this.close();
            this.onRename(dropdown.getValue(), input.value.trim());
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
        
        let folderNames = [];
        if (worldsFolder && worldsFolder instanceof TFolder) {
            for (let child of worldsFolder.children) {
                if (child instanceof TFolder) {
                    let worldFile = child.children.find(file => file instanceof TFile && file.name === "World.md");
                    if (worldFile) {
                        folderNames.push(child.name);
                    }
                }
            }
        }
        return folderNames;
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
