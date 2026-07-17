import { App, Modal, Setting } from 'obsidian';

export interface LinkFieldChoice {
	/** frontmatter key, e.g. "location", "traits" */
	key: string;
	/** display label, e.g. "Location", "Traits" */
	label: string;
	/** true for multi_link (YAML list), false for single_link (string) */
	multi: boolean;
	/** target element type (lowercase singular), e.g. "location" */
	target: string;
	/** how many links this field currently holds on the note (0 = empty) */
	count: number;
}

/**
 * Step 1 of the Link Elements flow (Phase B): choose which link FIELD to fill.
 * The element picker (ElementSelectionModal) follows for the chosen field.
 */
export class FieldSelectionModal extends Modal {
	private category: string;
	private fields: LinkFieldChoice[];
	private onChoose: (choice: LinkFieldChoice) => void;

	constructor(
		app: App,
		category: string,
		fields: LinkFieldChoice[],
		onChoose: (choice: LinkFieldChoice) => void
	) {
		super(app);
		this.category = category;
		this.fields = fields;
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Link a field on this ${this.category}` });

		// Single links first, then multi; within each, empty fields before filled
		// (you usually want to fill a gap), then alphabetical.
		const sorted = [...this.fields].sort((a, b) => {
			if (a.multi !== b.multi) return a.multi ? 1 : -1;
			if ((a.count === 0) !== (b.count === 0)) return a.count === 0 ? -1 : 1;
			return a.label.localeCompare(b.label);
		});

		for (const field of sorted) {
			const kind = field.multi ? 'Multi' : 'Single';
			const state = field.count > 0
				? `${field.count} linked`
				: 'empty';
			const setting = new Setting(contentEl)
				.setName(field.label)
				.setDesc(`${kind} → ${field.target}  ·  ${state}`)
				.addButton((b) =>
					b.setButtonText(field.count > 0 ? 'Edit' : 'Add').setTooltip(
						field.count > 0 ? 'Add or remove links' : 'Add links'
					).onClick(() => {
						this.close();
						this.onChoose(field);
					})
				);
			// Dim fields that already have links so empty ones stand out.
			if (field.count > 0) setting.nameEl.style.opacity = '0.7';
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
