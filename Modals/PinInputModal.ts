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
            .setDesc('Enter your OnlyWorlds PIN to verify access.')
            .addText(text => text
                .setPlaceholder('Enter your PIN')
                .setValue(this.pin)
                .onChange(value => {
                    // Keep only numeric characters and limit to 4 digits
                    this.pin = value.replace(/[^0-9]/g, '').substring(0, 4);
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
                    // Validate PIN is exactly 4 digits
                    const pinNum = parseInt(this.pin, 10);
                    if (this.pin && this.pin.length === 4 && !isNaN(pinNum) && pinNum >= 1000 && pinNum <= 9999) {
                        this.close();
                        this.onSubmit(this.pin);
                    } else {
                        // Show validation error
                        const errorEl = contentEl.querySelector('.pin-error');
                        if (errorEl) errorEl.remove();
                        
                        const error = contentEl.createEl('div', { 
                            text: 'Please enter a valid 4-digit PIN (1000-9999)', 
                            cls: 'pin-error' 
                        });
                        error.style.color = 'var(--text-error)';
                        error.style.fontSize = '0.8em';
                        error.style.marginTop = '5px';
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