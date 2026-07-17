// Assuming that each command class has a similar interface that includes an execute method.
import { CreateHandlebarsCommand } from './CreateHandlebarsCommand';
import { CreateReadmeCommand } from './CreateReadmeCommand';
import { CreateSettingsCommand } from './CreateSettingsCommand';
import { CreateTemplatesCommand } from './CreateTemplatesCommand';

export class CreateCoreFilesCommand {
    private app: any;
    private manifest: any;
    private commands: Array<any>;

    /**
     * `includeLegacyTemplates` (default FALSE as of 3.0.0) controls whether the
     * old PluginFiles/Templates + PluginFiles/Handlebars sets are fetched from
     * GitHub. NOTHING reads those templates anymore — every note write goes
     * through writeElement / frontmatter (verified at the compiled-bundle level,
     * 2026-07-16) — so the fetch is dead weight + a network call on every world
     * create/download/paste. All callers now opt out; the flag + the two Create*
     * template commands are kept (not deleted) as a reversible safety margin.
     */
    constructor(app: any, manifest: any, includeLegacyTemplates: boolean = false) {
        this.app = app;
        this.manifest = manifest;

        this.commands = [
            new CreateReadmeCommand(app, manifest),
            new CreateSettingsCommand(app, manifest),
        ];
        if (includeLegacyTemplates) {
            this.commands.push(
                new CreateTemplatesCommand(app, manifest),
                new CreateHandlebarsCommand(app, manifest),
            );
        }
    }

    public async execute(): Promise<void> { 
        for (const command of this.commands) {
            await command.execute();
        }
    }
}
