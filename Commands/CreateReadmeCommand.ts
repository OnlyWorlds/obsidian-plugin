import { App, PluginManifest, Notice, normalizePath } from 'obsidian';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export class CreateReadmeCommand {
    private app: App;
    private manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        const readmePath = normalizePath('OnlyWorlds/README.md');
        const readmeTemplatePath = resolve((this.app.vault.adapter as any).getBasePath(), '.obsidian', 'plugins', 'obsidian-plugin', 'README.md');

        try {
            let content = "## OnlyWorlds Plugin\n\nWelcome to the OnlyWorlds plugin. This document provides detailed instructions and information on how to use the OnlyWorlds plugin effectively.\n\n### Features\n- Manage and organize your world building directly within Obsidian.\n- Easy access to templates and settings.\n\n### Installation\nTo install, navigate to Obsidian's Community Plugins section and search for 'OnlyWorlds'. Follow the prompts to install.\n\n### Usage\nThis plugin allows you to create and manage elements of your worlds. Start by creating a new world from the Templates directory.\n\n### Support\nFor support, updates, and contributions, please visit the GitHub repository or contact the support team.";

            // Optionally read from a template file if exists
            if (existsSync(readmeTemplatePath)) {
                content = readFileSync(readmeTemplatePath, 'utf-8');
            }

            // Check if the README already exists
            if (!this.app.vault.getAbstractFileByPath(readmePath)) {
                await this.app.vault.create(readmePath, content);
             //   new Notice('README created successfully.');
            } else {
                // If it exists, you might want to update it or leave as is based on your use case
                await this.app.vault.modify(this.app.vault.getAbstractFileByPath(readmePath) as any, content);
             //   new Notice('README updated successfully.');
            }
        } catch (error) {
            console.error('Failed to create or update README:', error);
            new Notice('Error: Could not create or update README.');
        }
    }
}
