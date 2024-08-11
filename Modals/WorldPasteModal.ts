import { Category } from 'enums';
import { App, Modal, Notice } from 'obsidian';

export class WorldPasteModal extends Modal {
    onSubmit: (jsonData: any) => void;

    constructor(app: App, onSubmit: (jsonData: any) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create World From World Data' });

        // Create a textarea element
        let inputArea = contentEl.createEl('textarea', {
            placeholder: 'Insert JSON data here...',
            attr: {
                style: 'width: 100%; min-height: 200px; border: 1px solid grey; padding: 10px;'
            }
        });

        // Create a submit button
        const submitButton = contentEl.createEl('button', { text: 'Submit' });
        submitButton.style.opacity = '0.5';  // Start with the button greyed out
        submitButton.disabled = true;        // Start with the button disabled

        inputArea.addEventListener('input', (e) => {
            const value = (e.target as HTMLTextAreaElement).value;
            if (!value) {
                inputArea.style.borderColor = 'grey'; // Default border color
                submitButton.style.opacity = '0.5';
                submitButton.disabled = true;
                return;
            }
            if (this.isValidJSON(value)) {
                inputArea.style.borderColor = 'lightgreen'; // Green border for valid JSON
                submitButton.style.opacity = '1.0';
                submitButton.disabled = false;
            } else {
                inputArea.style.borderColor = 'salmon'; // Red border for invalid JSON
                submitButton.style.opacity = '0.5';
                submitButton.disabled = true;
            }
        });

        submitButton.onclick = () => {
            if (!submitButton.disabled) {
                this.onSubmit(JSON.parse(inputArea.value)); 
                this.close();
            }
        };
    }

    
    
     isValidJSON(str: string): boolean {
        try {
            const data = JSON.parse(str);
    
            const categories = Object.values(Category).filter(key => typeof key === 'string');

            // Validate existence of categories
            for (let category of categories) {
                if (!data[category] || !Array.isArray(data[category])) {
                    return false; // Each category must exist and be an array
                }
            }
    
            // Check only for the existence of the World object
            if (!data.World || typeof data.World !== 'object') {
                return false;
            }
    
            return true; // All checks passed
        } catch (e) {
            return false;  // In case of an error during parsing
        }
    }
    

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
