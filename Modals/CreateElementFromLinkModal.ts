import { App, DropdownComponent, Modal, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { Category } from '../enums';
import { WorldService } from '../Scripts/WorldService';

export class CreateElementFromLinkModal extends Modal {
    private onSubmit: (worldName: string, category: string, elementName: string) => void;
    private worldService: WorldService;
    private defaultCategory: string | null;

    constructor(
        app: App, 
        onSubmit: (worldName: string, category: string, elementName: string) => void,
        worldService: WorldService,
        defaultCategory: string | null = null
    ) {
        super(app);
        this.onSubmit = onSubmit;
        this.worldService = worldService;
        this.defaultCategory = defaultCategory;
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create New Element' });
        contentEl.addClass('create-element-modal');

        // World Selection Section
        const worldLabel = contentEl.createEl('label', { text: 'World' });
        worldLabel.style.display = 'block';
        worldLabel.style.marginBottom = '4px';
        worldLabel.style.fontWeight = 'bold';
        
        const worldFolders = await this.getWorldFolders();
        const worldDropdown = new DropdownComponent(contentEl);
        worldDropdown.selectEl.style.width = '100%';
        worldDropdown.selectEl.style.marginBottom = '15px';

        worldFolders.forEach(folder => {
            worldDropdown.addOption(folder, folder);
        });

        // Set default world selection
        if (worldFolders.length > 0) {
            const activeWorldName = await this.worldService.getWorldName();
            const defaultWorld = activeWorldName && worldFolders.includes(activeWorldName) 
                ? activeWorldName 
                : worldFolders[0];
            worldDropdown.setValue(defaultWorld);
        }

        // Category Selection Section (with autocomplete)
        const categoryLabel = contentEl.createEl('label', { text: 'Category' });
        categoryLabel.style.display = 'block';
        categoryLabel.style.marginBottom = '4px';
        categoryLabel.style.fontWeight = 'bold';
        
        const categoryInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Type to select a category...',
            cls: 'create-element-category-input'
        });
        categoryInput.style.width = '100%';
        categoryInput.style.marginBottom = '15px';

        // Create datalist for autocomplete
        const dataListId = 'categories-list';
        categoryInput.setAttribute('list', dataListId);
        const dataListEl = contentEl.createEl('datalist');
        dataListEl.id = dataListId;

        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));
        categories.forEach(category => {
            dataListEl.createEl('option', { value: category });
        });

        // Set default category if provided
        if (this.defaultCategory) {
            // Ensure the category matches exactly (case-sensitive)
            const matchingCategory = categories.find(cat => cat.toLowerCase() === this.defaultCategory!.toLowerCase());
            if (matchingCategory) {
                categoryInput.value = matchingCategory;
            } else {
                // If no exact match, just use the provided default
                categoryInput.value = this.defaultCategory;
            }
        }

        // Element Name Section
        const nameLabel = contentEl.createEl('label', { text: 'Element Name' });
        nameLabel.style.display = 'block';
        nameLabel.style.marginBottom = '4px';
        nameLabel.style.fontWeight = 'bold';
        
        const nameInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Enter element name...',
            cls: 'create-element-name-input'
        });
        nameInput.style.width = '100%';
        nameInput.style.marginBottom = '20px';
        
        // Set default name based on category if provided
        if (this.defaultCategory) {
            nameInput.value = `new ${this.defaultCategory.toLowerCase()}`;
            // Focus and select the text for easy replacement
            setTimeout(() => {
                nameInput.focus();
                nameInput.select();
            }, 50);
        }

        // Button Container
        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '20px';

        // Cancel Button
        const cancelButton = contentEl.createEl('button', {
            text: 'Cancel',
            cls: 'create-element-cancel-btn'
        });
        cancelButton.style.flex = '1';
        cancelButton.style.marginRight = '10px';
        cancelButton.addEventListener('click', () => {
            this.close();
        });

        // Create Button
        const createButton = contentEl.createEl('button', {
            text: 'Create',
            cls: 'mod-cta create-element-create-btn'
        });
        createButton.style.flex = '1';
        createButton.addEventListener('click', async () => {
            const worldName = worldDropdown.getValue();
            const category = categoryInput.value.trim();
            const elementName = nameInput.value.trim();

            if (!worldName || !category || !elementName) {
                new Notice('Please fill in all fields');
                return;
            }

            this.onSubmit(worldName, category, elementName);
            this.close();
        });

        buttonContainer.appendChild(cancelButton);
        buttonContainer.appendChild(createButton);
    }

    private async getWorldFolders(): Promise<string[]> {
        const worldsPath = normalizePath('OnlyWorlds/Worlds');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);
        
        if (worldsFolder instanceof TFolder) {
            return worldsFolder.children
                .filter(child => child instanceof TFolder)
                .map(folder => folder.name);
        }
        
        return [];
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}