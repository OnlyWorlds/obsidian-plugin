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
     */
    constructor(app: any, manifest: any) {
        this.app = app;
        this.manifest = manifest;

        this.commands = [
            new CreateReadmeCommand(app, manifest),
        ];
    }

    public async execute(): Promise<void> { 
        for (const command of this.commands) {
            await command.execute();
        }
    }
}
