import { App, Modal, PluginManifest, Setting } from 'obsidian';
import { CreateElementCommand } from '../Commands/CreateElementCommand';
import { WorldService } from '../Scripts/WorldService';
import { CreateElementFromLinkModal } from './CreateElementFromLinkModal';

/**
 * The element picker for Link Elements (3.0.0 rework): a TOGGLE list, not an
 * add-only list. Every element of the target type is shown; already-linked ones
 * start checked. Clicking toggles link/unlink. On Done, the caller receives the
 * FULL desired set (so it can add AND remove). A search box filters long lists.
 *
 * Single-link fields behave as a radio: picking one clears the rest and closes.
 * Multi-link fields accumulate; Done confirms the set.
 */
export class ElementSelectionModal extends Modal {
    private elements: { name: string; id: string }[];
    private elementType: string;
    private fieldName: string;
    private multi: boolean;
    private selectedIds: Set<string>;
    private onSelect: (selectedElements: { name: string; id: string }[]) => void;
    private worldService: WorldService;
    private manifest: PluginManifest;
    private fetchElements: () => Promise<{ name: string; id: string }[]>;
    private filter = '';

    constructor(
        app: App,
        elements: { name: string; id: string }[],
        elementType: string,
        fieldName: string,
        multi: boolean,
        preselectedIds: Set<string>,
        onSelect: (selectedElements: { name: string; id: string }[]) => void,
        worldService: WorldService,
        manifest: PluginManifest,
        fetchElements: () => Promise<{ name: string; id: string }[]>
    ) {
        super(app);
        this.elements = elements;
        this.elementType = elementType;
        this.fieldName = fieldName;
        this.multi = multi;
        this.selectedIds = new Set(preselectedIds);
        this.onSelect = onSelect;
        this.worldService = worldService;
        this.manifest = manifest;
        this.fetchElements = fetchElements;
    }

    onOpen() {
        this.renderContent();
    }

    private emitAndClose() {
        const chosen = this.elements.filter((e) => this.selectedIds.has(e.id));
        this.onSelect(chosen);
        this.close();
    }

    private renderContent() {
        const { contentEl } = this;
        contentEl.empty();

        // Header: title + create-new button.
        const header = contentEl.createDiv();
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '0.75em';
        header.createEl('h2', {
            text: this.multi ? `Link ${this.fieldName}` : `Set ${this.fieldName}`,
        });
        const addButton = header.createEl('button', {
            text: '+',
            attr: {
                'aria-label': `Create new ${this.elementType}`,
                'style': 'font-size: 1.4em; padding: 0 0.5em; cursor: pointer; background: transparent; border: none; color: var(--text-normal);',
            },
        });
        addButton.addEventListener('click', () => this.handleCreateNewElement());

        // Search box.
        const search = contentEl.createEl('input', {
            type: 'text',
            placeholder: `Search ${this.elementType}...`,
        });
        search.style.width = '100%';
        search.style.marginBottom = '0.75em';
        search.value = this.filter;
        search.addEventListener('input', () => {
            this.filter = search.value.toLowerCase();
            this.renderList();
        });

        this.listContainer = contentEl.createDiv();
        this.renderList();

        // Footer: Done (multi only — single closes on pick).
        if (this.multi) {
            const footer = contentEl.createDiv();
            footer.style.display = 'flex';
            footer.style.justifyContent = 'flex-end';
            footer.style.marginTop = '0.75em';
            const done = footer.createEl('button', { text: 'Done', cls: 'mod-cta' });
            done.addEventListener('click', () => this.emitAndClose());
        }

        setTimeout(() => search.focus(), 0);
    }

    private listContainer: HTMLDivElement;

    private renderList() {
        const c = this.listContainer;
        c.empty();
        c.style.maxHeight = '50vh';
        c.style.overflowY = 'auto';

        const matches = this.elements.filter((e) =>
            !this.filter || e.name.toLowerCase().includes(this.filter)
        );
        // Checked items first, then alphabetical (already sorted upstream).
        matches.sort((a, b) => {
            const sa = this.selectedIds.has(a.id), sb = this.selectedIds.has(b.id);
            if (sa !== sb) return sa ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        if (matches.length === 0) {
            c.createEl('p', { text: this.filter ? 'No matches.' : `No ${this.elementType} elements found. Click '+' to create.` });
            return;
        }

        for (const element of matches) {
            const checked = this.selectedIds.has(element.id);
            const row = new Setting(c).setName(element.name);
            if (this.multi) {
                row.addToggle((t) =>
                    t.setValue(checked).onChange((val) => {
                        if (val) this.selectedIds.add(element.id);
                        else this.selectedIds.delete(element.id);
                        // Re-sort so toggled items move, but keep focus in list.
                    })
                );
            } else {
                // Single link: radio-style. Show current with a check; pick sets + closes.
                if (checked) row.nameEl.style.fontWeight = '600';
                row.addButton((b) =>
                    b.setButtonText(checked ? 'Linked ✓' : 'Set').onClick(() => {
                        this.selectedIds = new Set([element.id]);
                        this.emitAndClose();
                    })
                );
            }
        }

        // Single-link: offer a clear button so a user can UNSET the field.
        if (!this.multi && this.selectedIds.size > 0) {
            const clear = new Setting(c);
            clear.addButton((b) =>
                b.setButtonText('Clear link').setWarning().onClick(() => {
                    this.selectedIds = new Set();
                    this.emitAndClose();
                })
            );
        }
    }

    private handleCreateNewElement() {
        const createElementModal = new CreateElementFromLinkModal(
            this.app,
            async (worldName, category, elementName) => {
                await new CreateElementCommand(this.app, this.manifest, this.worldService)
                    .execute(category, elementName, worldName, false);
                await new Promise((resolve) => setTimeout(resolve, 500));
                await this.refreshElementList();
            },
            this.worldService,
            this.elementType
        );
        createElementModal.open();
    }

    private async refreshElementList() {
        try {
            this.elements = await this.fetchElements();
            this.renderList();
        } catch (error) {
            console.error('Failed to refresh element list:', error);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
