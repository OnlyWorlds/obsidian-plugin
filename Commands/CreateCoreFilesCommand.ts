// Assuming that each command class has a similar interface that includes an execute method.
import { CreateReadmeCommand } from './CreateReadmeCommand';

export class CreateCoreFilesCommand {
    private app: any;
    private manifest: any;
    private commands: Array<any>;

    /**
     * The vault's Readme note. (The Settings note went in 3.18: the settings pane is the one place. The legacy PluginFiles/Templates
     * and PluginFiles/Handlebars fetch is gone: nothing read those templates
     * since 3.0.0, and their upstream sources were deleted on 2026-07-28.)
     *
     * `localOnly`: a local-only world makes no request to anyone (the README's privacy section
     * says so), so it gets no Readme note fetched from GitHub; the world's own World.md carries its how-to.
     */
    constructor(app: any, manifest: any, options: { localOnly?: boolean } = {}) {
        this.app = app;
        this.manifest = manifest;

        this.commands = options.localOnly ? [] : [
            new CreateReadmeCommand(app, manifest),
        ];
    }

    public async execute(): Promise<void> { 
        for (const command of this.commands) {
            await command.execute();
        }
    }
}
