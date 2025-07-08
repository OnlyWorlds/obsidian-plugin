import { App, DropdownComponent, Modal, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { Category } from '../enums';
import { WorldService } from '../Scripts/WorldService';

export class CreateElementModal extends Modal {
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
        if (this.defaultCategory && categories.includes(this.defaultCategory)) {
            categoryInput.value = this.defaultCategory;
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
        
        // Create Button
        const createButton = buttonContainer.createEl('button', { text: 'CREATE' });
        createButton.style.marginLeft = '8px';
        createButton.addEventListener('click', () => {
            const selectedCategory = this.validateCategory(categoryInput.value, categories, dataListEl);
            if (selectedCategory) {
                categoryInput.value = selectedCategory; // Ensure full category name is shown
                this.validateAndSubmit(worldDropdown.getValue(), selectedCategory, nameInput.value);
            }
        });

        // Handle Enter key in category input
        categoryInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const selectedCategory = this.validateCategory(categoryInput.value, categories, dataListEl);
                if (selectedCategory) {
                    categoryInput.value = selectedCategory; // Auto-complete the full category name
                    nameInput.focus(); // Move to name input after category selection
                }
            }
        });

        // Handle category input changes for direct matches
        categoryInput.addEventListener('input', () => {
            const value = categoryInput.value;
            if (categories.includes(value)) {
                nameInput.focus(); // Auto-advance to name input when exact match
            }
        });

        // Handle Enter key in name input
        nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                const selectedCategory = this.validateCategory(categoryInput.value, categories, dataListEl);
                if (selectedCategory) {
                    categoryInput.value = selectedCategory; // Ensure full category name is shown
                    this.validateAndSubmit(worldDropdown.getValue(), selectedCategory, nameInput.value);
                }
            }
        });

        // Focus category input first for typing workflow
        categoryInput.focus();
        if (categoryInput.value) {
            categoryInput.select(); // Select the pre-filled text
        }
    }

    validateAndSubmit(worldName: string, category: string, elementName: string) {
        if (!elementName.trim()) {
            new Notice('Please enter an element name');
            return;
        }

        if (!worldName) {
            new Notice('Please select a world');
            return;
        }

        if (!category) {
            new Notice('Please select a category');
            return;
        }

        this.close();
        this.onSubmit(worldName, category, elementName.trim());
    }

    validateCategory(inputValue: string, categories: string[], dataListEl: HTMLElement): string | null {
        const trimmedValue = inputValue.trim();

        // Try exact match first
        if (categories.includes(trimmedValue)) {
            return trimmedValue;
        }

        // Try to find the first datalist option that starts with the input value
        const matchedOption = Array.from(dataListEl.querySelectorAll('option'))
            .find(option => option.value.toLowerCase().startsWith(trimmedValue.toLowerCase()));

        if (matchedOption) {
            return matchedOption.value;
        }

        new Notice('No matching category found. Please select a valid category.');
        return null;
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