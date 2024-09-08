import { App, PluginManifest, Notice, normalizePath, TFile } from 'obsidian';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export class CreateReadmeCommand {
    private app: App;
    private manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }
    hasBasePath(adapter: any): adapter is { getBasePath: () => string } {
        return typeof adapter.getBasePath === 'function';
    }

    async execute(): Promise<void> {
        // Using normalizePath to ensure path consistency across different platforms
        const readmePath = normalizePath('OnlyWorlds/README.md');
        
        // Dynamically get the config directory from the user's settings
        const configDir = this.app.vault.configDir;

        // Construct the path using the user-configured directory
        var readmeTemplatePath =  "";

        const adapter = this.app.vault.adapter;
        if (this.hasBasePath(adapter)) {
            readmeTemplatePath = resolve(adapter.getBasePath(), configDir, 'plugins', 'onlyworlds-builder', 'README.md');
        } else {
            console.error("Adapter does not support getBasePath");
        } 
        try {
            let content = "## OnlyWorlds Plugin\n\nWelcome to the OnlyWorlds plugin. This document provides detailed instructions and information on how to use the OnlyWorlds plugin effectively.\n\n### Features\n- Manage and organize your world building directly within Obsidian.\n- Easy access to templates and settings.\n\n### Installation\nTo install, navigate to Obsidian's Community Plugins section and search for 'OnlyWorlds'. Follow the prompts to install.\n\n### Usage\nThis plugin allows you to create and manage elements of your worlds. Start by creating a new world from the Templates directory.\n\n### Support\nFor support, updates, and contributions, please visit the GitHub repository or contact the support team.";

            // Optionally read from a template file if exists
            if (existsSync(readmeTemplatePath)) {
                content = readFileSync(readmeTemplatePath, 'utf-8');
            }

            // Check if the README already exists
            if (!this.app.vault.getAbstractFileByPath(readmePath)) {
                await this.app.vault.create(readmePath, content); 
            } else { 
                const readmeFile = this.app.vault.getAbstractFileByPath(readmePath);
 
                if (readmeFile instanceof TFile) {
                    await this.app.vault.modify(readmeFile, content);
                } else {
                    console.error("The README file was not found or is not a file."); 
                }
            }
        } catch (error) {
            console.error('Failed to create or update README:', error);
            new Notice('Error: Could not create or update README.');
        }
    }
}
