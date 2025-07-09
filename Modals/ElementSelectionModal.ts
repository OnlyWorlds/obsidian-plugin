import { App, Modal, PluginManifest, Setting } from 'obsidian';
import { CreateElementCommand } from '../Commands/CreateElementCommand';
import { WorldService } from '../Scripts/WorldService';
import { CreateElementFromLinkModal } from './CreateElementFromLinkModal';

export class ElementSelectionModal extends Modal {
    private elements: { name: string; id: string }[];
    private elementType: string;
    private fieldName: string;
    private onSelect: (selectedElements: { name: string; id: string }[]) => void;
    private worldService: WorldService;
    private manifest: PluginManifest;
    private fetchElements: () => Promise<{ name: string; id: string }[]>;

    constructor(
        app: App, 
        elements: { name: string; id: string }[], 
        elementType: string, 
        fieldName: string, 
        onSelect: (selectedElements: { name: string; id: string }[]) => void,
        worldService: WorldService,
        manifest: PluginManifest,
        fetchElements: () => Promise<{ name: string; id: string }[]>
    ) {
        super(app);
        this.elements = elements;
        this.elementType = elementType;
        this.fieldName = fieldName;
        this.onSelect = onSelect;
        this.worldService = worldService;
        this.manifest = manifest;
        this.fetchElements = fetchElements;
    }

    onOpen() {
        this.renderContent();
    }
    
    private renderContent() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Create header container
        const headerContainer = contentEl.createDiv({ cls: 'modal-header-container' });
        headerContainer.style.display = 'flex';
        headerContainer.style.alignItems = 'center';
        headerContainer.style.justifyContent = 'space-between';
        headerContainer.style.marginBottom = '1em';
        
        // Add header text
        headerContainer.createEl('h2', { 
            text: `Select ${this.elementType} for ${this.fieldName}`,
            cls: 'modal-header-text'
        });
        
        // Add '+' button
        const addButton = headerContainer.createEl('button', {
            text: '+',
            cls: 'clickable-icon mod-cta',
            attr: {
                'aria-label': `Create new ${this.elementType}`,
                'style': 'font-size: 1.5em; padding: 0 0.5em; cursor: pointer; border: none !important; background: transparent !important; outline: none !important; box-shadow: none !important; color: var(--text-normal);'
            }
        });
        
        addButton.addEventListener('click', () => {
            this.handleCreateNewElement();
        });

        const listContainer = contentEl.createDiv({ cls: 'element-list-container' });
        
        if (this.elements.length === 0) {
            listContainer.createEl('p', { text: `No ${this.elementType} elements found. Click '+' to create` });
        } else {
            this.elements.forEach(element => {
                new Setting(listContainer)
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
    
    private handleCreateNewElement() {
        const createElementModal = new CreateElementFromLinkModal(
            this.app,
            async (worldName, category, elementName) => {
                await new CreateElementCommand(this.app, this.manifest, this.worldService)
                    .execute(category, elementName, worldName, false); // Don't open the file
                
                // Wait a bit for the file system to catch up
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Refresh the element list
                await this.refreshElementList();
            },
            this.worldService,
            this.elementType // Use current element type as default category
        );
        createElementModal.open();
    }
    
    private async refreshElementList() {
        try {
            // Fetch updated elements
            this.elements = await this.fetchElements();
            
            // Re-render the modal content
            this.renderContent();
        } catch (error) {
            console.error('Failed to refresh element list:', error);
        }
    }
}
