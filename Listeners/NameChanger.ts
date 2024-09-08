import { App, MarkdownView, Notice, TFile } from 'obsidian';

export class NameChanger {
    private app: App;

    constructor(app: App) {  // Ensure the app instance is passed correctly
        this.app = app;
    }

    setupNameChangeListener() {
        this.app.vault.on('rename', async (file: TFile, oldPath: string) => {
            const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '');
            if (file instanceof TFile && file.extension === 'md' && oldName) {
                const newName = file.basename;
                const content = await this.app.vault.read(file);
                const nameRegex = new RegExp(`<span class="text-field" data-tooltip="Text">Name</span>:\\s*${oldName}(\\n|$)`);

                if (nameRegex.test(content)) {
                    const newContent = content.replace(nameRegex, `<span class="text-field" data-tooltip="Text">Name</span>: ${newName}$1`);
                    await this.app.vault.modify(file, newContent);

                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView && activeView.file === file) {
                        activeView.editor.setValue(newContent);
                        new Notice('Name synchronized to: ' + newName);
                    }
                }
            }
        });
    }
}

 