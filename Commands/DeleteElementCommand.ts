import { App, Modal, Notice, TFile } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import { readElement } from '../vault/element-file';
import { LOCAL_WORLD_SYNC_MESSAGE, READ_ONLY_WORLD_MESSAGE, resolveWorldKey } from '../vault/world-key';
import { isStaleWrite, V2ApiError } from '../client-v2';
import { readChangeSeq, recordChangeSeqs } from '../vault/change-seq-index';
import { staleDeleteMessage } from '../sync/stale-save';

/** What removing a known-of note says (OW Infra #454). */
export const KNOWN_OF_DELETED = 'Note moved to trash. It was known of, so nothing was deleted on onlyworlds.com.';

/**
 * Delete the active element note's element from onlyworlds.com, then move the
 * note to trash. Human-gated by design: a typed-name confirm modal, one element
 * at a time, never bulk — deletion through this plugin is always a deliberate
 * per-element act (sibling instinct to the MCP's no-delete rule: AI never
 * deletes; humans delete only on purpose).
 */
export class DeleteElementCommand {
    app: App;
    plugin: OnlyWorldsPlugin;

    constructor(app: App, plugin: OnlyWorldsPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    async execute() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Open an element note first.');
            return;
        }
        const pathInfo = this.extractPathInfo(activeFile.path);
        if (!pathInfo) {
            new Notice('The active note is not an OnlyWorlds element.');
            return;
        }
        const { worldName, category } = pathInfo;

        // Identity from the note body (frontmatter first, span fallback).
        let elementId: string | null = null;
        let elementName: string = activeFile.basename;
        const v2 = await readElement(this.app, activeFile);
        if (v2 && v2.id) {
            elementId = v2.id;
            if (typeof v2.fields.name === 'string' && v2.fields.name) elementName = v2.fields.name;
        } else {
            const content = await this.app.vault.read(activeFile);
            const idMatch = content.match(/>Id<\/span>:\s*(\S+)/);
            const nameMatch = content.match(/>Name<\/span>:\s*(.+)$/m);
            elementId = idMatch ? idMatch[1].trim() : null;
            if (nameMatch) elementName = nameMatch[1].trim();
        }
        if (!elementId) {
            new Notice('Could not find this element\'s ID in the note.');
            return;
        }

        // A known-of note is a stub of an element this reader only knows of:
        // removing it is local, never a DELETE on onlyworlds.com (OW Infra
        // #454, h37 #8936, 8). Before the read-key refusal: a player with a
        // read key may still remove a note of their own vault.
        if (v2?.knownOf) {
            new DeleteConfirmModal(this.app, elementName, category, 'known-of', () => {
                void this.app.fileManager.trashFile(activeFile).then(() => new Notice(KNOWN_OF_DELETED, 8000));
            }).open();
            return;
        }

        // Resolve BEFORE the modal so its wording tells the truth: a local-only
        // world's delete touches nothing on onlyworlds.com.
        const preResolved = await resolveWorldKey(this.app, worldName, this.plugin.settings.apiKey);
        const isLocalWorld = preResolved.source === 'local-world';
        if (preResolved.readOnly) {
            // A read key can never delete: refuse before the confirm dialog,
            // so no one types a name for a delete that cannot happen
            // (Seethe's walk of rc-next, h37 #6462). Nothing is sent.
            new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
            return;
        }

        new DeleteConfirmModal(this.app, elementName, category, isLocalWorld ? 'local' : 'server', async () => {
            const resolved = await resolveWorldKey(this.app, worldName, this.plugin.settings.apiKey);
            if (resolved.source === 'local-world') {
                // Local-only world: nothing exists server-side; just trash the note.
                await this.app.fileManager.trashFile(activeFile as TFile);
                new Notice('Note moved to trash (local-only world — nothing to delete on onlyworlds.com).');
                return;
            }
            if (resolved.readOnly) {
                // Before any PIN; the note stays (Kael's review 3.1).
                new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
                return;
            }
            if (!resolved.apiKey) {
                new Notice('Delete failed: no API key found in World.md or settings.');
                return;
            }
            if (!resolved.ownWorld) {
                new Notice('Warning: using the plugin settings key (no key in this world\'s World.md).', 8000);
            }
            const client = await this.plugin.buildV2Client(resolved.apiKey);
            if (!client) {
                new Notice('Delete cancelled: PIN not provided.');
                return;
            }
            try {
                // The change_seq the note was last pulled or saved at, as a save
                // sends it (OW Obsidian #557): a delete is guarded the same way.
                const ifMatch = await readChangeSeq(this.app, worldName, elementId);
                await client.deleteElement(category.toLowerCase(), elementId, { ifMatch });
                await recordChangeSeqs(this.app, worldName, { [elementId]: null });
                new Notice(`${category} "${elementName}" deleted from onlyworlds.com.`);
            } catch (error) {
                // Changed on the server since the note was pulled: nothing was
                // deleted, and the note stays.
                if (isStaleWrite(error)) {
                    new Notice(staleDeleteMessage(category, elementName), 12000);
                    return;
                }
                // Already gone server-side → proceed to trash the note anyway.
                if (error instanceof V2ApiError && error.status === 404) {
                    new Notice(`${category} "${elementName}" did not exist on the server — removing the note.`);
                } else {
                    const msg = error instanceof Error ? error.message : 'Unknown error';
                    new Notice(`Delete failed: ${msg}`, 10000);
                    return; // server delete failed for a real reason — keep the note
                }
            }
            // Respect the user's trash preference (system trash / .trash / permanent).
            await this.app.fileManager.trashFile(activeFile as TFile);
            new Notice('Note moved to trash.');
        }).open();
    }

    private extractPathInfo(filePath: string): { worldName: string; category: string } | null {
        const pattern = /^OnlyWorlds\/Worlds\/([^\/]+)\/Elements\/([^\/]+)\/.+\.md$/i;
        const match = filePath.match(pattern);
        if (match && match[1] && match[2]) {
            return { worldName: match[1], category: match[2].replace(/\s*\(\d+\)$/, '') };
        }
        return null;
    }
}

/** Typed-name confirmation — deleting is deliberate, never a reflex click. */
class DeleteConfirmModal extends Modal {
    private elementName: string;
    private category: string;
    /** `server`: the element is deleted there; `local`: a local-only world; `known-of`: a known-of note, removed here only. */
    private reach: 'server' | 'local' | 'known-of';
    private onConfirm: () => void;

    constructor(app: App, elementName: string, category: string, scope: 'server' | 'local' | 'known-of', onConfirm: () => void) {
        super(app);
        this.elementName = elementName;
        this.category = category;
        this.reach = scope;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: `Delete ${this.category} "${this.elementName}"?` });
        contentEl.createEl('p', { text: this.reach === 'known-of'
            ? 'This moves the note to trash. You only know of this element, so nothing is deleted on onlyworlds.com.'
            : this.reach === 'local'
            ? 'This moves the note to trash (local-only world — nothing exists on onlyworlds.com). Links from other elements to it will dangle.'
            : 'This permanently deletes the element from onlyworlds.com and moves this note to trash. Links from other elements to it will dangle.' });
        contentEl.createEl('p', { text: `Type the element name to confirm:` });
        const input = contentEl.createEl('input', { type: 'text' });
        input.style.width = '100%';
        const btn = contentEl.createEl('button', { text: this.reach === 'known-of' ? 'Move to trash' : 'Delete permanently' });
        btn.style.marginTop = '10px';
        btn.disabled = true;
        input.addEventListener('input', () => {
            btn.disabled = input.value.trim() !== this.elementName;
        });
        btn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
        input.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}
