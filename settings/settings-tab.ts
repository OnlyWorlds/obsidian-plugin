import { App, PluginSettingTab, Setting } from "obsidian";
import type OnlyWorldsPlugin from "../main";

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

		new Setting(containerEl).setName("Auto-sync").setHeading();

		new Setting(containerEl)
			.setName("Auto-sync to OnlyWorlds")
			.setDesc(
				"When on, element notes are pushed to onlyworlds.com a short time after you stop editing. " +
					"When off, use the Save Element command (Ctrl/Cmd+Shift+S) to push manually."
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
	}
}
