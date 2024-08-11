import { App, Plugin, MarkdownView, Notice, TFile } from 'obsidian';

export class NameChanger extends Plugin {
    

    setupNameChangeListener() { 

        this.registerEvent(
            this.app.vault.on('rename', async (file: TFile, oldPath: string) => { 
                const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '');
                if (file instanceof TFile && file.extension === 'md' && oldName) {
                    const newName = file.basename;
                 //   console.log('CHECK 1  newname ' + newName);
                //    console.log('CHECK 1  oldName ' + oldName);
                    const content = await this.app.vault.read(file);
                    const nameRegex = new RegExp(`<span class="text-field" data-tooltip="Text">Name</span>:\\s*${oldName}(\\n|$)`);
                //    console.log('CHECK 1  nameRegex ' + nameRegex);
                //    console.log('CHECK 1  content ' + content);
                    
                    if (nameRegex.test(content)) { 
                    const newContent = content.replace(nameRegex, `<span class="text-field" data-tooltip="Text">Name</span>: ${newName}$1`);
                        await this.app.vault.modify(file, newContent);

                        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (activeView && activeView.file === file) {
                            const editor = activeView.editor;
                            editor.setValue(newContent);
                            new Notice('Name synchronized to: ' + newName);
                        }
                    }
                }
            })
        );
    }
}
