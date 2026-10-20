import { roleWords, type AccountWorld } from "../account/account-api";

/**
 * The account's worlds as a list of rows, each with its name, its role in
 * words and a DOWNLOAD button. Text only (createEl text): world names are
 * remote text and never go through innerHTML. Styles: styles.css, .ow-account-*.
 */
export function renderAccountWorlds(
	el: HTMLElement,
	worlds: AccountWorld[],
	onPick: (w: AccountWorld) => void
): void {
	el.empty();
	if (worlds.length === 0) {
		el.createEl("p", { text: "This account has no worlds yet. Create one on onlyworlds.com, or with Create world." });
		return;
	}
	for (const w of worlds) {
		const row = el.createDiv({ cls: "ow-account-world" });
		const label = row.createDiv({ cls: "ow-account-world-label" });
		label.createSpan({ text: w.name || "(unnamed world)" });
		label.createSpan({ text: ` · ${roleWords(w)}`, cls: "ow-account-world-role" });
		const pick = row.createEl("button", { text: "Download" });
		pick.addEventListener("click", () => onPick(w));
	}
}
