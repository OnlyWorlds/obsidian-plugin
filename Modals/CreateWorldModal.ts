import { App, Modal, Notice } from 'obsidian';
import { WorldService } from '../Scripts/WorldService';

export interface WorldCreationData {
    name: string;
    email: string;
    pin: number;
}

export class CreateWorldModal extends Modal {
    onSubmit: (data: WorldCreationData | null) => void;
    private worldService: WorldService;

    constructor(app: App, onSubmit: (data: WorldCreationData | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.worldService = new WorldService(app);
    }

    async onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create New World' });
        
        // World Name Field
        const nameLabel = contentEl.createEl('label', { text: 'World Name' });
        nameLabel.style.display = 'block';
        nameLabel.style.marginTop = '15px';
        nameLabel.style.marginBottom = '4px';
        nameLabel.style.fontWeight = 'bold';
        
        const nameInput = contentEl.createEl('input', {
            type: 'text',
            placeholder: '',
        });
        nameInput.style.width = '100%';
        nameInput.style.marginBottom = '15px';
        
        // Email Field
        const emailLabel = contentEl.createEl('label', { text: 'OnlyWorlds Email Address' });
        emailLabel.style.display = 'block';
        emailLabel.style.marginBottom = '4px';
        emailLabel.style.fontWeight = 'bold';
        
        // Get default email from settings
        const defaultEmail = await this.worldService.getDefaultEmailFromSettings();
        
        const emailInput = contentEl.createEl('input', {
            type: 'email',
            placeholder: '',
        });
        emailInput.style.width = '100%';
        emailInput.style.marginBottom = '15px';
        
        // Pre-fill email if available from settings
        if (defaultEmail) {
            emailInput.value = defaultEmail;
        }
        
        // PIN Field
        const pinLabel = contentEl.createEl('label', { text: 'OnlyWorlds PIN' });
        pinLabel.style.display = 'block';
        pinLabel.style.marginBottom = '4px';
        pinLabel.style.fontWeight = 'bold';
        
        const pinInput = contentEl.createEl('input', {
            type: 'password',
            placeholder: '',
        });
        pinInput.style.width = '100%';
        pinInput.style.marginBottom = '15px';
        
        // Add min/max attributes for 4-digit validation
        pinInput.setAttribute('min', '1000');
        pinInput.setAttribute('max', '9999');
        pinInput.setAttribute('maxlength', '4');
        
        // Prevent entering more than 4 digits
        pinInput.addEventListener('input', (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.value.length > 4) {
                target.value = target.value.slice(0, 4);
            }
        });
        
        // Description
        const description = contentEl.createEl('p');
        description.innerHTML = ``;
        // description.innerHTML = `Your email and PIN must match an OnlyWorlds account to assign ownership of the world.`;
        description.style.fontSize = '0.85em';
        description.style.fontStyle = 'italic';
        description.style.marginBottom = '20px';
        
        // Button Container
        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        buttonContainer.style.marginTop = '20px';
        
        // Cancel Button
        const cancelButton = buttonContainer.createEl('button', { text: 'CANCEL' });
        cancelButton.addEventListener('click', () => {
            this.close();
            this.onSubmit(null);
        });
        
        // Create Button
        const createButton = buttonContainer.createEl('button', { text: 'CREATE' });
        createButton.style.marginLeft = '8px';
        createButton.addEventListener('click', () => {
            this.validateAndSubmit(nameInput.value, emailInput.value, pinInput.value);
        });
        
        // Handle Enter key press
        nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                emailInput.focus();
            }
        });
        
        emailInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                pinInput.focus();
            }
        });
        
        pinInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.validateAndSubmit(nameInput.value, emailInput.value, pinInput.value);
            }
        });
        
        // Auto-focus the name input
        nameInput.focus();
    }
    
    validateAndSubmit(name: string, email: string, pinStr: string) {
        // Validate name
        if (!name.trim()) {
            new Notice('Please enter a world name');
            return;
        }
        
        // Validate email
        if (!this.isValidEmail(email)) {
            new Notice('Please enter a valid email address');
            return;
        }
        
        // Validate PIN
        const pin = parseInt(pinStr, 10);
        if (isNaN(pin) || pin < 1000 || pin > 9999) {
            new Notice('Please enter a valid 4-digit PIN');
            return;
        }
        
        // All validations passed
        this.close();
        this.onSubmit({
            name: name.trim(),
            email: email.trim(),
            pin: pin
        });
    }
    
    isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
} 