/**
 * A tiny stand-in for the slice of Obsidian's HTMLElement helpers the account
 * views use (createEl / createDiv / setText / addClass / addEventListener /
 * empty / style), so a test can render a list and click it. Text only: there
 * is no innerHTML here, as there is none in the code under test.
 */
export class FakeEl {
	children: FakeEl[] = [];
	text = "";
	classes: string[] = [];
	attrs: Record<string, string> = {};
	style: Record<string, string> = {};
	disabled = false;
	hidden = false;
	value = "";
	private listeners: Record<string, Array<(e: { preventDefault(): void }) => void>> = {};

	constructor(public tag = "div") {}

	createEl(tag: string, o?: { text?: string; cls?: string | string[]; type?: string; placeholder?: string; value?: string; href?: string }): FakeEl {
		const el = new FakeEl(tag);
		if (o?.text) el.text = o.text;
		if (o?.cls) el.classes.push(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")));
		if (o?.type) el.attrs.type = o.type;
		if (o?.placeholder) el.attrs.placeholder = o.placeholder;
		if (o?.href) el.attrs.href = o.href;
		if (o?.value) el.value = o.value;
		this.children.push(el);
		return el;
	}
	createDiv(o?: { text?: string; cls?: string }): FakeEl {
		return this.createEl("div", o);
	}
	createSpan(o?: { text?: string; cls?: string }): FakeEl {
		return this.createEl("span", o);
	}
	setText(t: string): void {
		this.text = t;
	}
	addClass(c: string): void {
		this.classes.push(c);
	}
	setAttribute(k: string, v: string): void {
		this.attrs[k] = v;
	}
	empty(): void {
		this.children = [];
		this.text = "";
	}
	addEventListener(ev: string, fn: (e: { preventDefault(): void }) => void): void {
		(this.listeners[ev] ??= []).push(fn);
	}
	focus(): void {}
	hide(): void {
		this.hidden = true;
	}
	show(): void {
		this.hidden = false;
	}
	/** A click, with an event whose preventDefault does nothing. */
	click(): void {
		for (const fn of this.listeners.click ?? []) fn({ preventDefault(): void {} });
	}
	/** Every descendant, depth first. */
	all(): FakeEl[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
	/** All text in this subtree, joined by " | ". */
	allText(): string {
		return [this.text, ...this.all().map((c) => c.text)].filter((t) => t).join(" | ");
	}
}
