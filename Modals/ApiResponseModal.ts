import { App, Modal } from 'obsidian';

export class ApiResponseModal extends Modal {
    success: boolean;
    message: string;
    details: Record<string, any> | null;
    onCloseCallback: () => void;
    customTitle: string | null;
    showDetails: boolean;

    constructor(
        app: App, 
        success: boolean, 
        message: string, 
        details: Record<string, any> | null = null, 
        onCloseCallback: () => void = () => {},
        customTitle: string | null = null,
        showDetails: boolean = true
    ) {
        super(app);
        this.success = success;
        this.message = message;
        this.details = details;
        this.onCloseCallback = onCloseCallback;
        this.customTitle = customTitle;
        this.showDetails = showDetails;
    }

    onOpen() {
        let { contentEl } = this;
        
        // Create header
        const icon = this.success ? '✅' : '❌';
        // Use custom title if provided, otherwise use default
        const title = this.success ? 'Success' : (this.customTitle || 'Error');
        
        const header = contentEl.createEl('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.marginBottom = '20px';
        
        const iconEl = header.createEl('span', { text: icon });
        iconEl.style.fontSize = '24px';
        iconEl.style.marginRight = '10px';
        
        header.createEl('h3', { text: title });
        
        // Create message
        const messageEl = contentEl.createEl('p', { text: this.message });
        messageEl.style.marginBottom = '15px';
        
        // Create details section if available and showDetails is true
        if (this.success && this.details && this.showDetails) {
            const detailsContainer = contentEl.createEl('div');
            detailsContainer.style.backgroundColor = '#f5f5f5';
            detailsContainer.style.padding = '10px';
            detailsContainer.style.borderRadius = '5px';
            detailsContainer.style.marginBottom = '15px';
            
            if (this.details.world_id) {
                const worldIdRow = detailsContainer.createEl('div');
                worldIdRow.createEl('strong', { text: 'World ID: ' });
                worldIdRow.createSpan({ text: this.details.world_id });
            }
            
            if (this.details.api_key) {
                const apiKeyRow = detailsContainer.createEl('div');
                apiKeyRow.createEl('strong', { text: 'API Key: ' });
                apiKeyRow.createSpan({ text: this.details.api_key });
                
                // Add a note about the API key
                const note = contentEl.createEl('p');
                note.style.fontSize = '0.9em';
                note.style.fontStyle = 'italic';
                note.style.marginTop = '5px';
                note.textContent = 'This API key is required for accessing your world. Please save it somewhere safe.';
            }
        } else if (this.success && this.details && !this.showDetails && this.details.api_key) {
            // If details are hidden for a success message, don't show any additional notes
        }
        
        // Create close button
        const buttonContainer = contentEl.createEl('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'center';
        
        const closeButton = buttonContainer.createEl('button', { text: 'Close' });
        closeButton.addEventListener('click', () => {
            this.close();
        });
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
        this.onCloseCallback();
    }
} 