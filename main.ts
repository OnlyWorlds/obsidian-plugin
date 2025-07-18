import { CopyWorldCommand } from 'Commands/CopyWorldCommand';
import { CreateElementCommand } from 'Commands/CreateElementCommand';
import { CreateHandlebarsCommand } from 'Commands/CreateHandlebarsCommand';
import { CreateReadmeCommand } from 'Commands/CreateReadmeCommand';
import { CreateSettingsCommand } from 'Commands/CreateSettingsCommand';
import { CreateWorldCommand } from 'Commands/CreateWorldCommand';
import { ExportWorldCommand } from 'Commands/ExportWorldCommand';
import { PasteWorldCommand } from 'Commands/PasteWorldCommand';
import { RenameWorldCommand } from 'Commands/RenameWorldCommand';
import { ValidateWorldCommand } from 'Commands/ValidateWorldCommand';
import { Category } from 'enums';
import { GraphViewExtensions } from 'Extensions/GraphViewExtensions';
import Handlebars from 'handlebars';
import { NameChanger } from 'Listeners/NameChanger';
import { NameInputModal } from 'Modals/NameInputModal';
import { CreateElementModal } from 'Modals/CreateElementModal';
import { Plugin, TFile, normalizePath } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { CreateTemplatesCommand } from './Commands/CreateTemplatesCommand';
import { ImportWorldCommand } from './Commands/ImportWorldCommand';
import { SaveElementCommand } from './Commands/SaveElementCommand';
// UpdateCategoryCountsCommand import removed - handled automatically by other operations
import { NoteLinker } from './Listeners/NoteLinker';

export default class OnlyWorldsPlugin extends Plugin {
  graphViewExtensions: GraphViewExtensions;
    noteLinker: NoteLinker;
    nameChanger: NameChanger;
    worldService: WorldService;
    private defaultCategory: string | null = null;
      onload(): void {

        this.worldService = new WorldService(this.app);
        this.registerHandlebarsHelpers(); 

        // didnt get custom graphview working yet
      //  this.graphViewExtensions = new GraphViewExtensions(this.app, this);
      //   this.graphViewExtensions.initializeGraphView();
      // this.addStyles(); 
       this.nameChanger = new NameChanger(this.app); 
       this.nameChanger.setupNameChangeListener();
        this.noteLinker = new NoteLinker(this.app,  this.worldService, this.manifest);  

 

      this.setupCommands();
      setTimeout(() => { 
        this.callDelayedFunctions();
    }, 500);  


      }
  

      callDelayedFunctions(){
        this.analyzeSettingsFile() ; 

        console.log("OnlyWorlds Plugin loaded"); 
      }

      addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .graph-view.color-fill-character { color: blue; }
            .graph-view.color-fill-location { color: green; }
            .graph-view.color-fill-event { color: red; }
            .graph-view.color-fill-default { color: grey; }
            // Add more styles for other categories as needed
        `;
        document.head.appendChild(style);
    }

    registerHandlebarsHelpers() {
      if (typeof Handlebars === 'undefined') {
        console.error("Handlebars is not available.");
        return;
      }
    
      Handlebars.registerHelper('linkify', (ids: string | string[]) => {
        if (!ids) return '';
        
        // Handle both string and array formats
        if (Array.isArray(ids)) {
          // If ids is already an array
          return ids.map(id => `[[${id.trim()}]]`).join(', ');
        } else {
          // If ids is a comma-separated string (legacy format)
          return ids.split(',').map(id => `[[${id.trim()}]]`).join(', ');
        }
      });

      // Add helper for formatting arrays consistently
      Handlebars.registerHelper('formatArray', (arr: string | string[]) => {
        if (!arr) return '';
        
        // Handle both string and array formats
        if (Array.isArray(arr)) {
          // If arr is already an array, join with commas
          return arr.join(', ');
        } else {
          // If arr is already a string, return as is
          return arr;
        }
      });
    }

      setupCommands() {
       
        const createReadmeCommand = new CreateReadmeCommand(this.app, this.manifest);
        const createTemplatesCommand = new CreateTemplatesCommand(this.app, this.manifest);
        const createHandlebarsCommand = new CreateHandlebarsCommand(this.app, this.manifest);
        const createSettingsCommand = new CreateSettingsCommand(this.app, this.manifest);
     //   const createCategoryFoldersCommand = new CreateCategoryFoldersCommand(this.app, this.manifest);
        const retrieveWorldCommand = new ImportWorldCommand(this.app, this.manifest);
        const sendWorldCommand = new ExportWorldCommand(this.app, this.manifest, this.worldService);        
        const createWorldCommand = new CreateWorldCommand(this.app, this.manifest);
        const validateWorldCommand = new ValidateWorldCommand(this.app, this.manifest, this.worldService, true);
        const pasteWorldCommand = new PasteWorldCommand(this.app, this.manifest);
        const copyWorldCommand = new CopyWorldCommand(this.app, this.manifest, this.worldService);
        const renameWorldCommand = new RenameWorldCommand(this.app, this.manifest);
        const saveElementCommand = new SaveElementCommand(this.app);
        // UpdateCategoryCountsCommand removed - handled automatically by other operations

        // manually handled in create/import world commands, no need for user to do this
        // // Register a command to create category folders
        // this.addCommand({
        //     id: 'create-category-folders',
        //     name: 'Create Element Folders',
        //     callback: () => {
        //         createCategoryFoldersCommand.execute();
        //     }
        // });

         
        // These excluded as user should not need to call them anyways; and settings/readme require fix on no existing folders
        // this.addCommand({
        //     id: 'setup-templates',
        //     name: 'Create Templates',
        //     callback: () => createTemplatesCommand.execute(),
        // });
        // this.addCommand({
        //     id: 'setup-settings',
        //     name: 'Create Settings',
        //     callback: () => createSettingsCommand.execute(),
        // });
        // this.addCommand({
        //     id: 'setup-readme',
        //     name: 'Create Readme',
        //     callback: () => createReadmeCommand.execute(),
        // });


          // Register a command to fetch world data and convert to notes
        this.addCommand({
            id: 'import-world',
            name: 'Import World',
            callback: () => retrieveWorldCommand.execute(),
        });

             // Register a command to convert nodes and send as world data
        this.addCommand({
            id: 'export-world',
            name: 'Export World',
            callback: () => sendWorldCommand.execute(),
        });

             // Register a command to create a new world and OW file structures
        this.addCommand({
            id: 'create-world',
            name: 'Create World',
            callback: () => createWorldCommand.execute(),
        });
      

        this.addCommand({
          id: 'create-element',
          name: 'Create Element',
          callback: () => {
              let createElementModal = new CreateElementModal(
                  this.app, 
                  (worldName, category, elementName) => {
                      new CreateElementCommand(this.app, this.manifest, this.worldService).execute(category, elementName, worldName);
                  },
                  this.worldService,
                  this.defaultCategory
              );
              createElementModal.open();
          }
      });
  
      this.addCommand({
        id: 'validate-world',
        name: 'Validate World',
        callback: () => validateWorldCommand.execute(),
    });
    this.addCommand({
      id: 'paste-world',
      name: 'Paste World from Clipboard',
      callback: () => pasteWorldCommand.execute(),
  });
      this.addCommand({
        id: 'copy-world',
        name: 'Copy World to Clipboard',
        callback: () => copyWorldCommand.execute(),
    });
      this.addCommand({
        id: 'rename-world',
        name: 'Rename World',
        callback: () => renameWorldCommand.execute(),
    });
   
    this.addCommand({
      id: 'save-element',
      name: 'Save Element',
      callback: () => saveElementCommand.execute(),
  });

    // Update Category Counts command removed - handled automatically by other operations

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', leaf => this.noteLinker.handleLeafChange(leaf))
  );

    // Listen for file deletions to update category counts
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleFileDelete(file))
  );

  this.addCommand({
      id: 'link-elements',
      name: 'Link Elements',
      callback: () => { 
          let editor = this.noteLinker.currentEditor;
          if (editor) {
              const cursor = editor.getCursor();
              const lineText = editor.getLine(cursor.line);
              if (this.noteLinker.isLineLinkField(lineText)) {
                  this.noteLinker.linkElement(editor, cursor, lineText);
              }
          }
      }
  });

    }

   
    async analyzeSettingsFile() {
      const settingsPath = normalizePath('OnlyWorlds/Settings.md');
      
      try {
          const settingsFile = this.app.vault.getAbstractFileByPath(settingsPath);
          if (!settingsFile) {
              console.log("Settings file not found, skipping check for creation of individual element commands.");
              return;
          }
          if (settingsFile instanceof TFile) { 
              const content = await this.app.vault.read(settingsFile);

              this.defaultCategory = this.parseSettingsForDefaultCategory(content);

              const individualCreationEnabled = this.parseSettingsForIndividualCreation(content); 
  
              if (individualCreationEnabled) {
                  this.registerIndividualCreationCommands();
              }
          } else {
              console.log("Found item is not a file, possibly a directory, skipping command creation.");
          }
      } catch (error) {
          console.error("Error accessing or reading settings file:", error); 
      }
  }
  
  async loadDefaultCategory() {
    const settingsPath = normalizePath('OnlyWorlds/Settings.md');
    try {
        const settingsFile = this.app.vault.getAbstractFileByPath(settingsPath);
        if (settingsFile instanceof TFile) {
            const content = await this.app.vault.read(settingsFile);
            this.defaultCategory = this.parseSettingsForDefaultCategory(content);
        }
    } catch (error) {
        console.error("Error loading settings file:", error);
    }
}
parseSettingsForDefaultCategory(content: string): string | null {
  const match = content.match(/^- \*\*Default New Element Category:\*\* ([^\n]+)/m);
  if (match) {
      const category = match[1].trim();
      // Validate if the category exists in the enum
      if (Object.keys(Category).includes(category)) {
          return category;
      }
  }
  return null;
}
  parseSettingsForIndividualCreation(content: string): boolean {
    const match = content.match(/^- \*\*Individual Element Creation Commands:\*\* (\w+)/m);
    return match ? match[1].toLowerCase() === 'yes' : false;
}

  async handleFileDelete(file: any) {
    // Check if deleted file is an element file in a world
    if (file.extension === 'md' && file.path.includes('OnlyWorlds/Worlds/') && file.path.includes('/Elements/')) {
      try {
        // Extract world name and category from path
        const pathParts = file.path.split('/');
        const worldsIndex = pathParts.indexOf('Worlds');
        if (worldsIndex >= 0 && pathParts.length > worldsIndex + 3) {
          const worldName = pathParts[worldsIndex + 1];
          const categoryFolderName = pathParts[worldsIndex + 3];
          
          // Extract base category name (remove count if present)
          const categoryMatch = categoryFolderName.match(/^([^(]+)(\s*\(\d+\))?$/);
          if (categoryMatch) {
            const baseCategory = categoryMatch[1].trim();
            
            // Update the category folder count
            await this.worldService.updateCategoryFolderName(worldName, baseCategory);
          }
        }
      } catch (error) {
        console.error('Error updating category count after file deletion:', error);
      }
    }
  }

  registerIndividualCreationCommands() {
      Object.keys(Category).filter(key => isNaN(Number(key))).forEach(category => {  
          this.addCommand({
              id: `create-new-${category.toLowerCase()}`,
              name: `Create new ${category}`,
              callback: () => {
                  let createElementModal = new CreateElementModal(
                      this.app, 
                      (worldName, cat, elementName) => {
                          new CreateElementCommand(this.app, this.manifest, this.worldService).execute(cat, elementName, worldName);
                      },
                      this.worldService,
                      category // Pre-select this specific category
                  );
                  createElementModal.open();
              }
          }); 
      });
  }
}
