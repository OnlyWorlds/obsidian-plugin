import { App, Plugin, MarkdownView, Editor, Notice, WorkspaceLeaf, EditorPosition, normalizePath, TFolder } from 'obsidian';
import { ElementSelectionModal } from '../Modals/ElementSelectionModal';
import { WorldService } from 'Scripts/WorldService';


export class NoteLinker {
    private worldService: WorldService;
    public  currentEditor: Editor | null = null;
    private app: App;

    constructor(app: App, worldService: WorldService) {  // Specify the type here
        this.app = app;
        this.worldService = worldService;
    }
  

    handleLeafChange(leaf: WorkspaceLeaf | null) {
        if (leaf && leaf.view instanceof MarkdownView) {
            this.currentEditor = leaf.view.editor;
        } else {
            this.currentEditor = null;
        }
    }

    public  isLineLinkField(line: string): boolean {
        return /<span class="(link-field|multi-link-field)"[^>]*>/.test(line);
    }

    public  async linkElement(editor: Editor, cursor: EditorPosition, lineText: string) {
        const currentFile = this.app.workspace.getActiveFile();
        if (currentFile) {
            const currentContent = await this.app.vault.read(currentFile);
            const { id: currentId } = this.parseElement(currentContent);
            
            const worldName = this.extractWorldName(currentFile.path);
            
            const match = /data-tooltip="(Single|Multi) (.*?)">/.exec(lineText);
            if (match) {
                const elementType = match[2];
                const fieldName = match[2]; // Assume this captures the field name correctly
                const elements = await this.fetchElements(elementType, currentId);
                
                new ElementSelectionModal(this.app, elements, elementType, fieldName, (selectedElements) => {
                    this.handleElementSelection(editor, cursor, lineText, selectedElements);
                }).open();
            }
        }
    }
    
    
    private async fetchElements(elementType: string, currentId: string): Promise<{ name: string; id: string }[]> {
        const topWorldName = await this.worldService.getWorldName();
        const elementsPath = `OnlyWorlds/Worlds/${topWorldName}/Elements/${elementType}`; 
    
        const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(elementsPath)); 
    
        const elements = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const { name, id } = this.parseElement(content);
        //    console.log(`Checking file: ${file.path}, Found Id: ${id}, Name: ${name}`); // Detailed log for each file
    
            if (id !== currentId) {
                elements.push({ name, id }); 
            }
        }
     
        return elements;
    }
 

    private extractWorldName(filePath: string): string { 
        const pathParts = filePath.split('/');
        const worldIndex = pathParts.indexOf('Worlds');
        if (worldIndex !== -1 && pathParts.length > worldIndex + 1) {
            return pathParts[worldIndex + 1];
        }
        return "Unknown World";  
    }
   

  private parseElement(content: string): { name: string, id: string } { 
    // Adjust the regex to capture the full ID including dashes and potential special characters
    const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([\w-]+)/);
    const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*(.+)/);

    const id = idMatch ? idMatch[1].trim() : "Unknown Id";
    const name = nameMatch ? nameMatch[1].trim() : "Unnamed Element"; 

    return { id, name };
}


private handleElementSelection(editor: Editor, cursor: EditorPosition, lineText: string, selectedElements: { name: string; id: string }[]) {
    const isMultiLink = /class="multi-link-field"/.test(lineText);
    const isLink = /class="link-field"/.test(lineText);

    let lineContent = editor.getLine(cursor.line);
    const insertionPoint = lineContent.indexOf('</span>:') + '</span>:'.length;
    let currentValues = lineContent.substring(insertionPoint).trim();

    if (isMultiLink) {
        // Existing values are preserved as links
        let existingValues = currentValues ? currentValues.split(',').map(v => v.trim()) : [];

        // Check and filter out already existing elements to prevent duplicates
        let newValues = selectedElements
            .filter(el => !existingValues.includes(`[[${el.name}]]`))
            .map(el => `[[${el.name}]]`);

        // Conditionally add a comma only if there are pre-existing elements, with no space after the comma
        let updatedValues = existingValues.concat(newValues).join(',');

        // Update the editor content with the new values
        editor.setLine(cursor.line, lineContent.substring(0, insertionPoint) + ' ' + updatedValues);
    } else if (isLink) {
        // Single link field: Replace existing value with the new selection
        let newValue = selectedElements.length > 0 ? `[[${selectedElements[0].name}]]` : '';
        editor.setLine(cursor.line, lineContent.substring(0, insertionPoint) + ' ' + newValue);
    }
 
}



    
    
    
    
    
}
