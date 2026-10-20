import { App, Modal } from 'obsidian';
import { applyMobileModal } from './mobile';

export class ValidateResultModal extends Modal {
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
        missingIdErrors: 'Elements must always have an ID value. If missing, google: "generate uuidv7" and generate one',
        nameMismatchErrors: 'Note names must exactly match value in Name field',
        worldFileErrors: 'Verify that the World data file has an ID and Name value'
    };

    constructor(app: App, errors: { 
        numberErrors: string[], 
        maxNumberErrors: string[], 
        singleLinkFieldErrors: string[], 
        multiLinkFieldErrors: string[], 
        missingIdErrors: string[], 
        nameMismatchErrors: string[], 
        worldFileErrors: string[]
    }, elementCount: number, errorCount: number, worldName: string, checkedCount?: number) {
        super(app);
        this.errors = errors;
        this.elementCount = elementCount;
        this.errorCount = errorCount;
        this.worldName = worldName;
        this.checkedCount = checkedCount ?? elementCount;
    }

    checkedCount: number;

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h1', { text: `Validated ${this.worldName}` });

        contentEl.createEl('p', { text: `Notes found: ${this.elementCount}. Checked: ${this.checkedCount} (an id, and a name that matches the file; number and link rules apply to notes in the pre-3.0 format).` });
        contentEl.createEl('p', { text: `Errors found: ${this.errorCount}` });

        if (this.errorCount > 0) {
            contentEl.createEl('p', { text: `Fix the issues below before uploading ${this.worldName}.` });
        } else if (this.checkedCount > 0) {
            contentEl.createEl('p', { text: `No issues in what was checked.` });
        } else {
            contentEl.createEl('p', { text: `Nothing was checked: no element notes found.` });
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

        const closeButton = contentEl.createEl('button', {
            text: 'Close',
            cls: 'mod-cta'
        });
        closeButton.addEventListener('click', () => {
            this.close();
        });
        applyMobileModal(this);
    }

    formatTitle(key: string): string {
        const words = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
