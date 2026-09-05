import { App, Modal } from 'obsidian';
import { applyMobileModal } from './mobile';

export interface NotePlan {
	path: string;
	name: string;
	category: string;
	/** text fields sitting in frontmatter that will move to body sections */
	movingFromFm: string[];
	/** body sections that will be added (empty scaffold) */
	missingSections: string[];
	/** frontmatter properties that will be added (empty) */
	missingProps: string[];
	/** body already contains a heading matching a field name — needs human eyes */
	needsReview: boolean;
}

export interface WorldFormatPlan {
	worldName: string;
	scanned: number;
	notes: NotePlan[];
}

/**
 * The dry run. Nothing is written until the user presses Update.
 *
 * This exists because the command rewrites notes people have written prose in.
 * A migration that runs first and reports after is not a migration a user can
 * trust — so the report IS the first step, and the notes needing human judgment
 * are named at the top rather than buried.
 */
export class UpdateWorldFormatModal extends Modal {
	constructor(app: App, private plan: WorldFormatPlan, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Update "${this.plan.worldName}" to the latest format` });

		const review = this.plan.notes.filter((n) => n.needsReview);
		const willChange = this.plan.notes.filter((n) => !n.needsReview);

		contentEl.createEl('p', {
			text:
				`${this.plan.scanned} notes scanned · ${willChange.length} will be updated` +
				(review.length ? ` · ${review.length} skipped for review` : ''),
		});

		const moving = willChange.filter((n) => n.movingFromFm.length).length;
		const ul = contentEl.createEl('ul');
		ul.createEl('li', { text: `Add missing fields (properties + body sections)` });
		if (moving) {
			ul.createEl('li', { text: `Move text fields into body sections on ${moving} note(s)` });
		}
		ul.createEl('li', { text: `Existing text is never deleted — only moved` });

		if (review.length) {
			const warn = contentEl.createDiv();
			warn.style.borderLeft = '3px solid var(--text-warning)';
			warn.style.padding = '8px 12px';
			warn.style.margin = '12px 0';
			warn.createEl('strong', { text: `${review.length} note(s) skipped — please look at these yourself` });
			warn.createEl('p', {
				text:
					'Their body already contains headings that match field names. Updating them ' +
					'would move that text out of the description, so they are left untouched.',
				cls: 'setting-item-description',
			});
			const rl = warn.createEl('ul');
			for (const n of review.slice(0, 10)) rl.createEl('li', { text: n.path });
			if (review.length > 10) rl.createEl('li', { text: `…and ${review.length - 10} more (see console)` });
		}

		if (willChange.length) {
			const details = contentEl.createEl('details');
			details.createEl('summary', { text: `Show the ${willChange.length} notes to be updated` });
			const list = details.createEl('ul');
			for (const n of willChange.slice(0, 200)) {
				const bits: string[] = [];
				if (n.movingFromFm.length) bits.push(`move ${n.movingFromFm.length}`);
				if (n.missingSections.length) bits.push(`+${n.missingSections.length} sections`);
				if (n.missingProps.length) bits.push(`+${n.missingProps.length} properties`);
				list.createEl('li', { text: `${n.name} (${n.category}) — ${bits.join(', ')}` });
			}
			if (willChange.length > 200) {
				list.createEl('li', { text: `…and ${willChange.length - 200} more` });
			}
		}

		const row = contentEl.createDiv();
		row.style.marginTop = '16px';
		const go = row.createEl('button', { text: `Update ${willChange.length} note(s)` });
		go.classList.add('mod-cta');
		go.disabled = willChange.length === 0;
		go.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.style.marginLeft = '8px';
		cancel.addEventListener('click', () => this.close());
		applyMobileModal(this);
	}

	onClose() {
		this.contentEl.empty();
	}
}
