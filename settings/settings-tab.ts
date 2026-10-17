import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OnlyWorldsPlugin from "../main";
import { TOKEN_STORAGE_NOTE, signIn, signOut, signedInLabel } from "../account/account-api";

export class OnlyWorldsSettingTab extends PluginSettingTab {
	plugin: OnlyWorldsPlugin;

	constructor(app: App, plugin: OnlyWorldsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("OnlyWorlds").setHeading();

		this.displayAccount(containerEl);

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				"Your world's API key: an ow_ key from your account page at onlyworlds.com, or a classic 10-digit key. Stored locally."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("API PIN")
			.setDesc(
				"Your 4-digit OnlyWorlds PIN. Stored locally. " +
					"Leave empty to be prompted once per session instead."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("4-digit PIN")
					.setValue(this.plugin.settings.apiPin)
					.onChange(async (value) => {
						const cleaned = value.replace(/[^0-9]/g, "").substring(0, 4);
						this.plugin.settings.apiPin = cleaned;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Default world")
			.setDesc(
				"Name of the world you are actively working on. " +
					"When empty, the alphabetically-first world under OnlyWorlds/Worlds/ is used."
			)
			.addText((text) =>
				text
					.setPlaceholder("World name")
					.setValue(this.plugin.settings.defaultWorld)
					.onChange(async (value) => {
						this.plugin.settings.defaultWorld = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default email")
			.setDesc("Pre-fills the email field when creating new worlds.")
			.addText((text) =>
				text
					.setPlaceholder("you@example.com")
					.setValue(this.plugin.settings.defaultEmail)
					.onChange(async (value) => {
						this.plugin.settings.defaultEmail = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default new element category")
			.setDesc("Pre-selected category in the Create Element command.")
			.addDropdown((dd) => {
				const cats = [
					"Character",
					"Object",
					"Location",
					"Species",
					"Zone",
					"Institution",
					"Family",
					"Creature",
					"Collective",
					"Trait",
					"Phenomenon",
					"Title",
					"Ability",
					"Language",
					"Law",
					"Relation",
					"Event",
					"Construct",
					"Narrative",
				];
				cats.forEach((c) => dd.addOption(c, c));
				dd.setValue(this.plugin.settings.defaultCategory).onChange(async (value) => {
					this.plugin.settings.defaultCategory = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Individual element creation commands")
			.setDesc(
				"Register a separate 'Create new <Category>' command for each element type. " +
					"Reload Obsidian for changes to take effect."
			)
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.individualElementCommands).onChange(async (value) => {
					this.plugin.settings.individualElementCommands = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Write a Bases file per world")
			.setDesc(
				"Download World and Create World write <world>.base beside World.md: a table and a card view " +
					"for each element type, in Obsidian's Bases (Obsidian 1.9 or later). Download never overwrites " +
					"a file you have changed. The Write Bases file command writes one any time, and rebuilds a " +
					"changed one, keeping your version beside it."
			)
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.writeBasesFile).onChange(async (value) => {
					this.plugin.settings.writeBasesFile = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Relationship canvas: links to the element")
			.setDesc(
				"Draw relationships on a canvas draws what the active element links to and, with this on, " +
					"the elements that link to it (it reads the world's notes once)."
			)
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.canvasIncomingLinks).onChange(async (value) => {
					this.plugin.settings.canvasIncomingLinks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Auto-sync").setHeading();

		new Setting(containerEl)
			.setName("Auto-sync to OnlyWorlds")
			.setDesc(
				"When on, element notes are pushed to onlyworlds.com a short time after you stop editing. " +
					"When off, run the Save Element command to push manually (give it a hotkey in Settings, Hotkeys)."
			)
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-sync debounce (ms)")
			.setDesc("How long to wait after the last edit before syncing. Default: 3000ms. Lower this if you want faster syncs; raise it if you find sync fires while you're still typing.")
			.addText((text) =>
				text
					.setPlaceholder("3000")
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 250 && n <= 30000) {
							this.plugin.settings.debounceMs = n;
							await this.plugin.saveSettings();
							this.plugin.autoSync?.rebuildDebouncer();
						}
					})
			);

		new Setting(containerEl)
			.setName("Show status bar indicator")
			.setDesc("Display sync state (synced / dirty / syncing / error) in the desktop status bar.")
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Rename note when the element's name changes")
			.setDesc(
				"After Save Element changes an element's name, rename its note to match. " +
					"Auto-sync never renames. Links to it update as your Files and links setting says."
			)
			.addToggle((tog) =>
				tog.setValue(this.plugin.settings.renameNoteOnNameChange).onChange(async (value) => {
					this.plugin.settings.renameNoteOnNameChange = value;
					await this.plugin.saveSettings();
				})
			);
	}

	/**
	 * The OnlyWorlds account (OW Infra #358): sign in with an account token, or
	 * Signed in as <username> with Sign out. The token is kept like the API key
	 * (masked, in data.json). Signed out, nothing else in the plugin changes.
	 */
	private displayAccount(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		if (settings.accountToken) {
			new Setting(containerEl)
				.setName(signedInLabel(settings.accountUsername || "your account"))
				.setDesc(
					"Download World offers your onlyworlds.com worlds, and Join a world with a link joins with this account. " +
						"Signing out keeps the worlds in this vault and their keys. " +
						TOKEN_STORAGE_NOTE
				)
				.addButton((b) =>
					b.setButtonText("Sign out").onClick(async () => {
						b.setDisabled(true);
						const out = await signOut(this.plugin);
						new Notice(out.message, out.revoked ? 5000 : 12000);
						this.display();
					})
				);
			return;
		}

		let draft = "";
		new Setting(containerEl)
			.setName("OnlyWorlds account")
			.setDesc(
				"Sign in with an account token to see your onlyworlds.com worlds here. " +
					"Make a token on onlyworlds.com, in Account settings under Account tokens."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("ow_a_…").onChange((value) => {
					draft = value;
				});
			})
			.addButton((b) =>
				b
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							const username = await signIn(this.plugin, draft);
							new Notice(signedInLabel(username));
							this.display();
						} catch (e) {
							new Notice(e instanceof Error ? e.message : String(e), 8000);
							b.setDisabled(false);
						}
					})
			);
	}
}
