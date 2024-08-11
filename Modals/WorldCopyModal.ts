import { Modal, App } from 'obsidian';

export class WorldCopyModal extends Modal {
    worldName: string;

    constructor(app: App, worldName: string) {
        super(app);
        this.worldName = worldName;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h3', { text: `Copied ${this.worldName}` });
        contentEl.createEl('p', {
            text: `Copied ${this.worldName} to clipboard and to World Data file`
        });
        contentEl.createEl('button', { text: 'OK', type: 'button' }, (button) => {
            button.onclick = () => this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
