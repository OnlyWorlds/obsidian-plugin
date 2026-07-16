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
		for (const field of this.fields) {
			new Setting(contentEl)
				.setName(field.label)
				.setDesc(`${field.multi ? 'Multi' : 'Single'} link -> ${field.target}`)
				.addButton((b) =>
					b.setButtonText('Choose').onClick(() => {
						this.close();
						this.onChoose(field);
					})
				);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
