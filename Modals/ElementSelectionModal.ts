import { App, Modal, Setting } from 'obsidian';

export class ElementSelectionModal extends Modal {
    private elements: { name: string; id: string }[];
    private elementType: string;
    private fieldName: string;
    private onSelect: (selectedElements: { name: string; id: string }[]) => void;

    constructor(app: App, elements: { name: string; id: string }[], elementType: string, fieldName: string, onSelect: (selectedElements: { name: string; id: string }[]) => void) {
        super(app);
        this.elements = elements;
        this.elementType = elementType;
        this.fieldName = fieldName;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: `Select ${this.elementType} for field: ${this.fieldName}` });

        if (this.elements.length === 0) {
            contentEl.createEl('p', { text: `No ${this.elementType} elements found` });
        } else {
            this.elements.forEach(element => {
                new Setting(contentEl)
                    .setName(element.name)
                    .setDesc(`Id: ${element.id}`)
                    .addButton(button => {
                        button.setButtonText('Select')
                            .onClick(() => {
                                this.onSelect([element]);
                                this.close();
                            });
                    });
            });
        }
    }
}
