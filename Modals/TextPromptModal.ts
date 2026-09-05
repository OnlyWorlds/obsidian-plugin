import { App, Modal } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';

/**
 * A minimal one-line text prompt. `NameInputModal` is element-creation shaped
 * (it takes a category and its button reads CREATE), so this is the generic
 * sibling for anything else that needs a single string.
 */
export class TextPromptModal extends Modal {
	private value = '';

	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private onSubmit: (value: string) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		const input = this.contentEl.createEl('input', {
			type: 'text',
			placeholder: this.placeholder,
		});
		input.style.width = '100%';
		input.addEventListener('input', (e: Event) => {
			this.value = (e.target as HTMLInputElement).value;
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') this.submit();
		});

		const row = this.contentEl.createDiv();
		row.style.marginTop = '12px';
		const ok = row.createEl('button', { text: 'Add' });
		ok.addEventListener('click', () => this.submit());
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.style.marginLeft = '8px';
		cancel.addEventListener('click', () => this.close());

		if (!suppressAutofocus()) window.setTimeout(() => input.focus(), 0);
		applyMobileModal(this);
	}

	private submit() {
		const v = this.value.trim();
		if (!v) return;
		this.close();
		this.onSubmit(v);
	}

	onClose() {
		this.contentEl.empty();
	}
}
