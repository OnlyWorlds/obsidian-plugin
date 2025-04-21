import { App, Modal, Setting } from 'obsidian';

export class PinInputModal extends Modal {
    pin: string = '';
    onSubmit: (pin: string | null) => void; // Callback function

    constructor(app: App, onSubmit: (pin: string | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty(); // Clear previous content
        contentEl.createEl('h2', { text: 'Enter OnlyWorlds PIN' });

        new Setting(contentEl)
            .setName('PIN')
            .setDesc('Enter your numeric OnlyWorlds PIN to save the element.')
            .addText(text => text
                .setPlaceholder('Enter your PIN')
                .setValue(this.pin)
                .onChange(value => {
                    // Keep only numeric characters
                    this.pin = value.replace(/[^0-9]/g, '');
                    // Optionally enforce max length if known (e.g., 4 digits)
                    // if (this.pin.length > 4) {
                    //    this.pin = this.pin.substring(0, 4);
                    // }
                    // Update the input field to show cleaned value immediately
                    text.setValue(this.pin);
                })
                // Set input type to 'password' to obscure input
                .inputEl.setAttribute('type', 'password')
             );


        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Submit')
                .setCta() // Makes the button more prominent
                .onClick(() => {
                    if (this.pin) { // Basic check if PIN is entered
                        this.close();
                        this.onSubmit(this.pin);
                    } else {
                        // Optionally show a small warning within the modal
                        // For now, just don't submit if empty
                    }
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                    this.onSubmit(null); // Indicate cancellation
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
} 