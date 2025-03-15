import { App, Modal } from 'obsidian';

export class ValidateExportResultModal extends Modal {
    private errors: {
        numberErrors: string[], 
        maxNumberErrors: string[], 
        singleLinkFieldErrors: string[], 
        multiLinkFieldErrors: string[], 
        missingIdErrors: string[], 
        nameMismatchErrors: string[], 
        worldFileErrors: string[]
    };
    private elementCount: number;
    private errorCount: number;
    private worldName: string;

    private errorTooltips = {
        numberErrors: 'Number fields can only have numeric (for now, whole) values',
        maxNumberErrors: 'Hover or click the field name to see the max allowed value',
        singleLinkFieldErrors: 'Can have one linked element, formatted as: [[NoteName]]',
        multiLinkFieldErrors: 'Can have multiple links, formatted as: [[NoteName1]],[[NoteName2]],[[NoteName3]]',
        missingIdErrors: 'Elements must always have an Id value. If missing, google: "generate uuidv7" and generate one',
        nameMismatchErrors: 'Note names must exactly match value in Name field',
        worldFileErrors: 'Verify that the World data file has an Id and Name value'
    };

    constructor(app: App, errors: { 
        numberErrors: string[], 
        maxNumberErrors: string[], 
        singleLinkFieldErrors: string[], 
        multiLinkFieldErrors: string[], 
        missingIdErrors: string[], 
        nameMismatchErrors: string[], 
        worldFileErrors: string[]
    }, elementCount: number, errorCount: number, worldName: string) {
        super(app);
        this.errors = errors;
        this.elementCount = elementCount;
        this.errorCount = errorCount;
        this.worldName = worldName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
    
        contentEl.createEl('h1', { text: `Validated ${this.worldName}` });
    
        contentEl.createEl('p', { text: `Total elements scanned: ${this.elementCount}` });
        contentEl.createEl('p', { text: `Errors found: ${this.errorCount}` });
    
        if (this.errorCount > 0) {
            contentEl.createEl('p', { text: `Please correct these issues to allow export of ${this.worldName}.` });
         } else {
            contentEl.createEl('p', { text: `No issues detected. ${this.worldName} is ready for export.` });
            contentEl.createEl('p', { text: `!WARNING!This will overwrite the world version stored on OnlyWorlds.com!` });
        }
    
        const errorKeys = Object.keys(this.errors) as (keyof typeof this.errors)[];
        let totalErrors = 0;
        errorKeys.forEach(key => {
            const errorList = this.errors[key];
            if (errorList.length > 0) {
                totalErrors += errorList.length;
                const errorSection = contentEl.createDiv();
                const header = errorSection.createEl('h3', { text: `${this.formatTitle(key)}` });
                header.setAttr('title', this.errorTooltips[key]); // Set tooltip
                errorList.forEach((error: string) => {
                    errorSection.createEl('p', { text: `- ${error}` });
                });
            }
        });
        
        // Create button container for consistent layout
        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '20px';
        
        // Cancel Button (always shown)
        const cancelButton = buttonContainer.createEl('button', { text: 'CANCEL' });
        cancelButton.addEventListener('click', () => {
            this.close();
        });
        
        // Export Button (only shown if validation passed)
        if (this.errorCount === 0) {
            const exportButton = buttonContainer.createEl('button', { text: 'EXPORT' });
            exportButton.style.marginLeft = '8px';
            exportButton.addEventListener('click', () => {
                this.exportCallback?.();
                this.close();
            });
        }
    }
    
    // Add a property to hold the export callback function
    private exportCallback?: () => void;
    
    // Add a method to set the export callback function
    setExportCallback(callback: () => void) {
        this.exportCallback = callback;
    }
    

    formatTitle(key: string): string {
        return key.replace(/([A-Z])/g, ' $1').trim().replace(/\b\w/g, char => char.toUpperCase());
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
