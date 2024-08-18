import { App, Modal, Notice, DropdownComponent, normalizePath, TFolder, TFile } from 'obsidian';

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

        contentEl.style.display = 'flex';
        contentEl.style.flexDirection = 'column';
        contentEl.style.gap = '10px';

        const worldFolders = await this.getWorldFolders();

        const dropdown = new DropdownComponent(contentEl);
        dropdown.selectEl.style.width = '100%'; 
        worldFolders.forEach(folder => {
            dropdown.addOption(folder, folder);
        });
        if (worldFolders.length > 0) {
            dropdown.setValue(this.activeWorldName || worldFolders[0]); // Pre-select the active world name
        }

        const input = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Please enter 10-digit world key',
            value: '0075037444'
        });
        input.style.width = '100%'; 

        const submitButton = contentEl.createEl('button', { text: 'Submit' });
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
        

        let folderNames = [];
        for (let child of worldsFolder.children) {
            if (child instanceof TFolder) {
                // Check if a specific file 'World.md' exists within this folder
                let worldFile = child.children.find(file => file instanceof TFile && file.name === "World.md");
                if (worldFile) {//
                    folderNames.push(child.name);
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
