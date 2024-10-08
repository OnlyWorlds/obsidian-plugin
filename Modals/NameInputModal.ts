import { App, Modal, Notice } from 'obsidian';

export class NameInputModal extends Modal {
    private inputValue: string = '';

    constructor(app: App, private category: string, private executeCreation: (category: string, name: string) => void) {
        super(app);
    }

    onOpen() {
        this.titleEl.setText(`Enter a name for the new ${this.category}`);

        let inputEl = this.contentEl.createEl('input', {
            type: 'text',
            placeholder: 'Name...'
        });

        // Corrected input event listener
        inputEl.addEventListener('input', (e: Event) => {
            const target = e.target as HTMLInputElement;  // Correctly type-cast the event target
            if (target) {
                this.inputValue = target.value.trim();
            }
        });
        

        // Keydown event to handle submission on pressing 'Enter'
        inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && this.isValidName(this.inputValue)) {
                this.executeCreation(this.category, this.inputValue);
                this.close();
            }
        });

        // Create the OK button
        const button = this.contentEl.createEl('button', { text: 'CREATE' });
        button.style.marginLeft = '10px';  // Add margin for spacing

        button.addEventListener('click', () => {
            if (this.isValidName(this.inputValue)) {
                this.submitForm();  // Submit form
            }
        });
        inputEl.focus();  // Focus the input element initially
        
    }

    submitForm() {
        this.executeCreation(this.category, this.inputValue);  // Execute the creation action
        this.close();  // Close the modal
    }

    isValidName(name: string): boolean {
        // Regular expression to match invalid characters that cannot be used in filenames
        const invalidChars = /[\\/*?"<>|:]/;
        if (name.length === 0 || invalidChars.test(name)) {
            new Notice('File name cannot contain any of these characters: * " \\ / < > : | ?');
            return false;
        }
        return true;
    }
    
    onClose() {
        this.contentEl.empty();
    }
}
