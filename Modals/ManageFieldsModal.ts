import { App, Modal, Setting } from 'obsidian';

export interface FieldChoice {
	/** schema key, e.g. "physicality" (or "x_looks" for a custom field) */
	key: string;
	/** heading/label shown to the user, e.g. "Physicality" */
	label: string;
	/** true when the note currently carries this field with content */
	hasContent: boolean;
	/** true when the section/property exists on the note at all (even if empty) */
	present: boolean;
	/** true for a custom x_ field the user added */
	custom: boolean;
	/** where the field lives — text fields are body sections, the rest properties */
	where: "body" | "frontmatter";
	/** display grouping: "Text" | "Numbers" | "Links" | "Custom" */
	group: string;
}

/**
 * "Manage fields" — tick the fields this element should carry.
 *
 * Both directions in one place (Captain's ask): ticking adds a field's section,
 * unticking removes it. A field WITH CONTENT is never silently removable — its
 * row is disabled and says so, because the alternative is a tickbox that
 * destroys prose. Clearing real content stays a deliberate act in the note.
 */
export class ManageFieldsModal extends Modal {
	private category: string;
	private fields: FieldChoice[];
	private selected: Set<string>;
	private onApply: (selected: Set<string>) => void;
	private onAddCustom: () => void;
	/** group name -> its header element, so counts update without a rebuild */
	private countEls = new Map<string, HTMLElement>();

	constructor(
		app: App,
		category: string,
		fields: FieldChoice[],
		onApply: (selected: Set<string>) => void,
		onAddCustom: () => void
	) {
		super(app);
		this.category = category;
		this.fields = fields;
		this.selected = new Set(fields.filter((f) => f.present).map((f) => f.key));
		this.onApply = onApply;
		this.onAddCustom = onAddCustom;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Fields on this ${this.category}` });
		contentEl.createEl('p', {
			text: 'Ticked fields appear as sections in the note body. Fields holding text cannot be removed here.',
			cls: 'setting-item-description',
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText('All').onClick(() => {
					for (const f of this.fields) this.selected.add(f.key);
					this.apply();
					this.renderRows(rows);
				})
			)
			.addButton((b) =>
				b.setButtonText('None').onClick(() => {
					// Never unticks a field that holds content — that is the guard.
					for (const f of this.fields) if (!f.hasContent) this.selected.delete(f.key);
					this.apply();
					this.renderRows(rows);
				})
			)
			.addButton((b) =>
				b.setButtonText('Add custom field…').onClick(() => {
					this.close();
					this.onAddCustom();
				})
			);

		const rows = contentEl.createDiv();
		this.renderRows(rows);

		// No Apply button: every toggle writes immediately. The button used to sit
		// below a long scrolling list, so a user could tick a dozen fields and lose
		// all of it by closing the modal (Captain, 2026-08-22). Live-apply removes
		// the failure instead of relocating it.
		contentEl.createEl('p', {
			text: 'Changes are applied to the note as you toggle.',
			cls: 'setting-item-description',
		});
	}

	/** Push the current selection to the note. Called on every change. */
	private apply() {
		this.onApply(new Set(this.selected));
	}

	/**
	 * Update just the "(3/7)" text on each group header. Kept separate from
	 * renderRows so a toggle never rebuilds the list — rebuilding resets the
	 * scroll position, and these lists run to 30+ rows.
	 */
	private refreshCounts() {
		for (const [name, el] of this.countEls) {
			const rows = this.fields.filter((f) => f.group === name);
			const on = rows.filter((r) => this.selected.has(r.key)).length;
			el.setText(`${name}  (${on}/${rows.length})`);
		}
	}

	private renderRows(container: HTMLElement) {
		container.empty();
		this.countEls.clear();
		// Grouped the way the note is laid out: body sections first (that is what
		// the reader sees when writing), then the property block.
		const order = ['Text', 'Custom', 'Numbers', 'Links'];
		const groups = new Map<string, FieldChoice[]>();
		for (const f of this.fields) {
			if (!groups.has(f.group)) groups.set(f.group, []);
			groups.get(f.group)!.push(f);
		}
		for (const name of order) {
			const rows = groups.get(name);
			if (!rows || rows.length === 0) continue;
			const on = rows.filter((r) => this.selected.has(r.key)).length;
			// Group header carries its own All/None — with 17 numbers on a
			// Character, per-group control is the difference between usable and not.
			const head = new Setting(container)
				.setName(`${name}  (${on}/${rows.length})`)
				.setDesc(rows[0].where === 'body' ? 'body sections' : 'note properties');
			head.settingEl.style.borderTop = '1px solid var(--background-modifier-border)';
			head.settingEl.style.paddingTop = '10px';
			head.nameEl.style.fontWeight = '600';
			this.countEls.set(name, head.nameEl);
			head.addButton((b) =>
				b.setButtonText('All').onClick(() => {
					for (const f of rows) this.selected.add(f.key);
					this.apply();
					this.renderRows(container);
				})
			);
			head.addButton((b) =>
				b.setButtonText('None').onClick(() => {
					for (const f of rows) if (!f.hasContent) this.selected.delete(f.key);
					this.apply();
					this.renderRows(container);
				})
			);
			for (const f of rows) {
				const s = new Setting(container).setName(f.label);
				if (f.hasContent) {
					s.setDesc(
						f.where === 'body'
							? 'has text — clear it in the note to remove'
							: 'has a value — clear it in the note to remove'
					);
				} else if (f.custom) {
					s.setDesc('custom field');
				}
				s.addToggle((t) => {
					t.setValue(this.selected.has(f.key));
					t.setDisabled(f.hasContent); // content is never destroyed by a tickbox
					t.onChange((v) => {
						if (v) this.selected.add(f.key);
						else this.selected.delete(f.key);
						this.apply(); // write immediately — nothing to lose by closing
						// Update the counts in place. A full renderRows() here rebuilt
						// the DOM and threw the scroll position to the top on every
						// tick, which makes a 30-row list unusable.
						this.refreshCounts();
					});
				});
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
