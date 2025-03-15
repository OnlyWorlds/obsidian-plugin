import { App, Modal, Notice } from 'obsidian';
import { Category } from '../enums';

export class TemplateSelectionModal extends Modal {
    private defaultCategory: string;

    constructor(app: App, private executeCreation: (category: string) => void, defaultCategory: string | null = null) {
        super(app);
        this.defaultCategory = defaultCategory || '';
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create element of category..' });

        // Create input field for category selection
        let inputEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Type to select a category...',
            value: this.defaultCategory // Prefill if a default category is available
        });

        // Assign ID to the input for the datalist association
        const dataListId = 'categories-list';
        inputEl.setAttribute('list', dataListId);

        // Create a datalist element and set the ID attribute manually
        let dataListEl = contentEl.createEl('datalist');
        dataListEl.id = dataListId;

        // Populate datalist with categories
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));
        categories.forEach(category => {
            dataListEl.createEl('option', { value: category });
        });

        // Handle keydown to select the top suggestion on 'Enter'
        inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault(); // Prevent the default form submit behavior

                this.handleCategorySelection(inputEl.value, dataListEl, categories);
            }
        });

        // Handle input changes for direct matches
        inputEl.addEventListener('input', () => {
            const value = inputEl.value;
            if (categories.includes(value)) {
                this.executeCreation(value);
                this.close();
            }
        });

        // Create "OK" button
        const button = contentEl.createEl('button', { text: 'CHOOSE' });
        button.style.marginLeft = '10px'; // Add some spacing between input and button

        // Handle button click for category selection
        button.addEventListener('click', () => {
            this.handleCategorySelection(inputEl.value, dataListEl, categories);
        });

        // Focus the input field and select all text
        inputEl.focus();
        if (inputEl.value) {
            inputEl.select(); // This will select all the text in the input
        }
    }

    handleCategorySelection(inputValue: string, dataListEl: HTMLElement, categories: string[]) {
        const trimmedValue = inputValue.trim();

        // Try to find the first datalist option that starts with the input value
        const matchedOption = Array.from(dataListEl.querySelectorAll('option'))
            .find(option => option.value.toLowerCase().startsWith(trimmedValue.toLowerCase()));

        if (matchedOption) {
            this.executeCreation(matchedOption.value);
            this.close();
        } else if (categories.includes(trimmedValue)) {
            // Handle case where user manually types an exact category
            this.executeCreation(trimmedValue);
            this.close();
        } else {
            new Notice('No matching category found.');
        }
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
