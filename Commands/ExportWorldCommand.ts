import { ValidateExportResultModal } from 'Modals/ValidateExportResultModal';
import { WorldPinSelectionModal } from 'Modals/WorldPinSelectionModal';
import { App, normalizePath, Notice, PluginManifest, TFile } from 'obsidian';
import { WorldService, sanitizeFileName } from 'Scripts/WorldService';
import { Category } from '../enums';
import { ValidateWorldCommand } from './ValidateWorldCommand';
import { decodeHtmlEntities } from '../Scripts/htmlEntities';
import { toV2Payload, V2ApiError, V2Client } from '../client-v2';
import { resolveWorldKey } from '../vault/world-key';
import { readElement } from '../vault/element-file';
import { isSpanFormat } from '../vault/element-transform';
import type OnlyWorldsPlugin from '../main';

export class ExportWorldCommand {
    app: App;
    manifest: PluginManifest;
    worldService: WorldService;
    plugin: OnlyWorldsPlugin | null;
    /** Link fields omitted from the current sweep because a link couldn't be
     *  resolved locally (server values preserved) — surfaced in the summary. */
    private skippedLinkFields = 0;

    constructor(app: App, manifest: PluginManifest, worldService: WorldService, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
        this.plugin = plugin ?? null;
    }

    async execute() {
        const activeWorldName = await this.worldService.getWorldName(); // Fetch the active world name

        // If a PIN is cached/persisted AND we have an active world, skip the picker.
        const cachedPin = this.plugin ? await this.plugin.pinCache.get() : null;
        if (cachedPin && activeWorldName) {
            const pinNum = parseInt(cachedPin, 10);
            if (!isNaN(pinNum)) {
                await this.runExport(pinNum, activeWorldName);
                return;
            }
        }

        new WorldPinSelectionModal(this.app, async (pin: number, worldFolder: string) => {
            await this.runExport(pin, worldFolder);
        }, activeWorldName).open();
    }

    private async runExport(pin: number, worldFolder: string): Promise<void> {
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(worldFolder);

        const validationModal = new ValidateExportResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder);

        validationModal.setExportCallback(async () => {
            if (validator.errorCount === 0) {
                const worldData = await this.collectWorldData(worldFolder);
                if (!worldData || Object.keys(worldData).length === 0) return;
                await this.uploadViaV2(pin, worldFolder, worldData);
            }
        });

        validationModal.open();
    }

    /**
     * v2 upload sweep (replaces the legacy worldsync/store full-replace).
     * Per element: exists on server → PATCH; local-only → created via /bulk
     * (atomic, server-side FK resolution handles cross-links in first pushes).
     * Elements that exist ONLY on the server are reported, never deleted —
     * the full-replace delete class is gone by design.
     */
    private async uploadViaV2(pin: number, worldFolder: string, worldData: Record<string, unknown>): Promise<void> {
        const resolved = await resolveWorldKey(this.app, worldFolder, this.plugin?.settings.apiKey);
        if (!resolved.apiKey) {
            new Notice('Upload failed: no API key found in World.md or settings.');
            return;
        }
        if (!resolved.ownWorld) {
            new Notice('Warning: using the plugin settings key (no key in this world\'s World.md). Verify it belongs to this world.', 10000);
        }
        const client = new V2Client(resolved.apiKey, String(pin));

        try {
            // Server element index — ids that exist right now (deletes drop out).
            const serverIds = new Set<string>();
            const walk = await client.changesWalk();
            const latestOp = new Map<string, string>();
            for (const change of walk.changes) latestOp.set(change.id, change.op);
            for (const [id, op] of latestOp) if (op === 'upsert') serverIds.add(id);

            // Partition local elements.
            const toCreate: { type: string; element: Record<string, unknown> }[] = [];
            const toUpdate: { type: string; id: string; payload: Record<string, unknown> }[] = [];
            for (const category in worldData) {
                if (category === 'World') continue;
                const elements = worldData[category];
                if (!Array.isArray(elements)) continue;
                const type = category.toLowerCase();
                for (const raw of elements) {
                    const element = toV2Payload(raw as Record<string, unknown>);
                    const id = element.id ? String(element.id) : null;
                    if (!id) continue; // no identity — validator should have caught it
                    if (serverIds.has(id)) {
                        const { id: _id, ...patchFields } = element;
                        toUpdate.push({ type, id, payload: patchFields });
                    } else {
                        toCreate.push({ type, element });
                    }
                }
            }
            const localIds = new Set<string>();
            for (const category in worldData) {
                if (category === 'World') continue;
                const elements = worldData[category];
                if (!Array.isArray(elements)) continue;
                for (const raw of elements) {
                    const id = (raw as Record<string, unknown>).id;
                    if (id) localIds.add(String(id));
                }
            }
            const serverOnly = [...serverIds].filter(id => !localIds.has(id)).length;

            // Progress feedback — the sweep can run for a minute on a big world.
            new Notice(`Uploading ${toCreate.length + toUpdate.length} elements (${toCreate.length} new, ${toUpdate.length} existing)...`);

            // Creates first (atomic /bulk — FK targets exist before updates run).
            let created = 0;
            if (toCreate.length > 0) {
                await client.bulkCreate(toCreate);
                created = toCreate.length;
            }

            // Updates, per element; collect failures instead of aborting the sweep.
            let updated = 0;
            const failures: string[] = [];
            const progressEvery = 50;
            for (const item of toUpdate) {
                try {
                    await client.update(item.type, item.id, item.payload);
                    updated++;
                    if (updated % progressEvery === 0) {
                        new Notice(`Uploading... ${updated}/${toUpdate.length}`);
                    }
                } catch (e) {
                    const name = item.payload.name ? String(item.payload.name) : item.id;
                    failures.push(`${item.type} "${name}": ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            let summary = `Upload complete: ${created} created, ${updated} updated.`;
            if (serverOnly > 0) {
                summary += ` ${serverOnly} element${serverOnly === 1 ? '' : 's'} exist only on the server (not deleted).`;
            }
            new Notice(summary, 8000);
            if (this.skippedLinkFields > 0) {
                new Notice(`${this.skippedLinkFields} link field${this.skippedLinkFields === 1 ? '' : 's'} skipped (unresolvable links) — server values kept. See console for details.`, 10000);
            }
            if (failures.length > 0) {
                console.error('Upload failures:', failures);
                new Notice(`${failures.length} element${failures.length === 1 ? '' : 's'} failed — first: ${failures[0]}`, 15000);
            }
        } catch (error) {
            console.error('Upload error:', error);
            if (error instanceof V2ApiError) {
                if (error.status === 401 || error.status === 403) {
                    new Notice('Upload failed: Invalid PIN or API key, or the key lacks write access.');
                } else {
                    new Notice(`Upload failed: ${error.message}`, 15000);
                }
            } else {
                new Notice(`Error during upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    }

    
    
    

    async collectWorldData(worldFolder: string) {
        this.skippedLinkFields = 0; // fresh count per sweep (incremented in parseTemplate)
        const fs = this.app.vault.adapter;
        let worldData: Record<string, unknown> = {};
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/World.md`);
    
        // Read the 'World' file content and parse it
        try {
            const worldFileContent = await fs.read(worldFilePath); 
            const worldInfo = this.parseWorldFile(worldFileContent);
            worldData['World'] = worldInfo; // Directly assign the object, not in an array
        } catch (error) {
            console.error('Error reading World file:', error);
            const msg = error instanceof Error ? error.message : String(error);
            new Notice('Failed to read World file: ' + msg);
            return {}; // Stop further processing if the World file cannot be read
        }
    
        // Iterate over categories to collect their data
        for (const categoryKey in Category) {
            const category = Category[categoryKey];
            if (isNaN(Number(category))) {
                const categoryDirectory = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements/${category}`);
                const files = this.app.vault.getFiles().filter(file => file.path.startsWith(categoryDirectory));
     
                const categoryData = await Promise.all(files.map(async (file) => {
                    // Phase B: frontmatter notes read via the shared element reader
                    // (id + typed fields + extension namespaces preserved); legacy
                    // span notes still fall through to the span parser so a mixed,
                    // partly-migrated world uploads correctly either way.
                    const fileContent = await fs.read(file.path);
                    if (!isSpanFormat(fileContent) && file instanceof TFile) {
                        const parsed = await readElement(this.app, file);
                        if (parsed) return parsed.fields;
                    }
                    return await this.parseTemplate(fileContent, worldFolder);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
    
        // Add debug logging at the end of the method, before returning the data
        try {
         //   console.log("WORLD DATA COLLECTION COMPLETE - Raw data structure:");
         //   console.log(JSON.stringify(worldData, null, 2));
            
            return worldData;
        } catch (error) {
            console.error("Error collecting world data:", error);
            new Notice("Error collecting world data: " + (error instanceof Error ? error.message : "Unknown error"));
            return null;
        }
    }
    
    private parseWorldFile(content: string): Record<string, string | string[]> {
        let currentSection: string | null = null;
        const data: Record<string, string | string[]> = {};
    
        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        const keyValuePattern = /- \*\*(.*?):\*\* (.*)/; // Pattern for key-value pairs
    
        const lines = content.split('\n');
        lines.forEach(line => {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]);
                return;
            }
    
            const match = line.match(keyValuePattern);
            if (match) {
                let key = this.toSnakeCase(match[1].replace(/\*\*/g, ''));
                const value = match[2].trim();
                
                // Special handling for image field
                if (key === 'image' || key === 'image_url') {
                    // If the image value is 'None', set it to empty string
                    if (value === 'None' || value === 'No image set') {
                        data[key] = '';
                    } else {
                        data[key] = value;
                    }
                } else if (key === 'time_format_names' || key === 'time_format_equivalents') {
                    // Support both formats:
                    // 1. If the value is already a JSON array string (starts with '[')
                    if (value.startsWith('[') && value.endsWith(']')) {
                        try {
                            // Parse as JSON array
                            data[key] = JSON.parse(value);
                        } catch (e) {
                            // If parsing fails, fall back to comma-separated string
                            data[key] = value.split(',').map(item => item.trim());
                        }
                    } else {
                        // 2. Parse as comma-separated string
                        data[key] = value.split(',').map(item => item.trim());
                    }
                } else {
                    data[key] = value;
                }
            }
        });
    
        return data;
    }
    
    
    
    private async extractLinkedIds(linkedText: string, lineText: string, worldFolder: string): Promise<string[] | null> {
        const linkPattern = /\[\[(.*?)\]\]/g;
        const ids: string[] = [];
        let match;
    
        // Extract the element type from the surrounding line context
        const elementTypeMatch = /data-tooltip="(Single|Multi) ([^"]+)"/.exec(lineText);
        const elementType = elementTypeMatch ? elementTypeMatch[2] : null; 
    
        if (!elementType) {
            console.error("Element type not found in the linked text");
            return ids;
        }
    
        let unresolved = 0;
        while ((match = linkPattern.exec(linkedText)) !== null) {
            const linkedName = match[1];

            // A uuid-shaped link IS the id (download writes [[<id>]] when it
            // can't resolve a name) — pass it through, identity preserved.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(linkedName)) {
                ids.push(linkedName);
                continue;
            }

            // Search for the element by name content instead of constructing file path
            const elementId = await this.findElementIdByName(linkedName, elementType, worldFolder);
            if (elementId) {
                ids.push(elementId);
            } else {
                unresolved++;
                console.error(`Linked file not found: ${linkedName}`);
            }
        }
        // Any unresolved link poisons the whole field: pushing a REDUCED list
        // would silently strip server-side links (the 2.3.0 smoke test class).
        // Returning null tells the caller to OMIT the field — server value wins.
        if (unresolved > 0) {
            console.warn(`Link field skipped (${unresolved} unresolved) — server value preserved.`);
            return null;
        }
        return ids;
    }
    
    private async findElementIdByName(elementName: string, elementType: string, worldFolder: string): Promise<string | null> {
        const categoryDirectory = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements/${elementType}`);
        const files = this.app.vault.getFiles().filter(file => file.path.startsWith(categoryDirectory));
        
        for (const file of files) {
            try {
                const fileContent = await this.app.vault.read(file);
                const { name, id } = this.parseElement(fileContent);

                // Match by name content rather than filename. Compare sanitized
                // forms too: wikilinks carry the FILENAME form (illegal chars
                // replaced), while the note's Name field keeps the exact name.
                if (name === elementName ||
                    (name && sanitizeFileName(name) === sanitizeFileName(elementName))) {
                    return id;
                }
            } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
            }
        }

        return null;
    }
    
    async parseTemplate(content: string, worldFolder: string): Promise<Record<string, unknown>> {
        let currentSection: string | null = null;
        const data: Record<string, unknown> = {};

        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        // Capture the tooltip so link/number fields are typed like SaveElementCommand.
        const keyValuePattern = /- <span class="[^"]+" data-tooltip="([^"]+)">(.+?)<\/span>:\s*(.*)/; // tooltip, key, value

        const lines = content.split('\n');
        for (const line of lines) {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]);
                continue;
            }

            const match = line.match(keyValuePattern);
            if (match) {
                const tooltip = match[1].trim();
                const originalKey = match[2].replace(/\*\*/g, '');
                let key = this.toSnakeCase(originalKey);
                // Decode entities from pre-noEscape notes so names/text ship raw,
                // and [[wikilink]] display text matches the target note's name.
                const value = decodeHtmlEntities(match[3].trim());

                // Special handling for TTRPG stats - use uppercase keys
                const ttrpgStats = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                if (ttrpgStats.includes(key.toLowerCase())) {
                    key = key.toUpperCase();
                }

                const lowerTooltip = tooltip.toLowerCase();
                // --- Links: ship as <field>_id / <field>_ids (UUIDs, never names) ---
                if (lowerTooltip.startsWith('single ') || lowerTooltip.startsWith('multi ')) {
                    const ids = value ? await this.extractLinkedIds(value, line, worldFolder) : [];
                    // A non-wikilink value in a link field can't be resolved to a UUID here
                    // (extractLinkedIds only matches [[Name]]). Never ship a raw name.
                    if (value && !value.includes('[[')) {
                        console.warn(`Link field "${key}" holds a non-wikilink value; nulling instead of shipping a name: "${value}"`);
                    }
                    if (ids === null) {
                        // Unresolved link(s) inside the field — OMIT it so the
                        // PATCH can't strip server-side links.
                        this.skippedLinkFields++;
                    } else if (lowerTooltip.startsWith('single ')) {
                        data[`${key}_id`] = ids.length > 0 ? ids[0] : null;
                    } else {
                        data[`${key}_ids`] = ids;
                    }
                }
                // --- Numbers ---
                else if (lowerTooltip === 'number' || ttrpgStats.includes(key.toLowerCase()) || key.match(/^[A-Z]{3}$/)) {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && /^\d+$/.test(value)) {
                        data[key] = num;
                    } else {
                        data[key] = value === '' ? null : value;
                    }
                }
                // --- Image fields ---
                else if (key === 'image' || key === 'image_url') {
                    if (value === 'None' || value === 'No image set') {
                        data[key] = '';
                    } else {
                        data[key] = value;
                    }
                }
                // --- Text (default) ---
                else {
                    // Empty fields ship as null, never "" — the API
                    // 422s "" on integer fields (height, weight, dates),
                    // while null reads as "no value" for every kind.
                    // SaveElementCommand's parser already does this.
                    data[key] = value === '' ? null : value;
                }
            }
        }

        return data;
    }
    
    
    
    private parseElement(content: string): { name: string, id: string } {
        // Adjust the regex to capture the full ID including dashes
        const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\r\n<]+)/);
        const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\r\n<]+)/);
        
        const id = idMatch ? idMatch[1].trim() : "Unknown Id";
        // Decode so the name matches decoded [[wikilink]] text in findElementIdByName
        // even for target notes still escaped on disk.
        const name = nameMatch ? decodeHtmlEntities(nameMatch[1].trim()) : "Unnamed Element";

        return { id, name };
    }

    // stop at dash 
    // private parseElement(content: string): { id: string } {
    //     const idMatch = content.match(/<span class="text-field" data-tooltip="Text">ID<\/span>:\s*([^<\r\n-]+)/);
    //     const id = idMatch ? idMatch[1].trim() : "Unknown ID";
    //     return { id };
    // }

  
    // Helper method to convert strings to snake_case
    toSnakeCase(input: string): string {
        return input.toLowerCase().replace(/\s+/g, '_').replace(/\(|\)|,/g, '');
    }
}
