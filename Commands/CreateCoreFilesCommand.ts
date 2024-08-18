// Assuming that each command class has a similar interface that includes an execute method.
import { CreateReadmeCommand } from './CreateReadmeCommand';
import { CreateSettingsCommand } from './CreateSettingsCommand';
import { CreateTemplatesCommand } from './CreateTemplatesCommand';

export class CreateCoreFilesCommand {
    private app: any;
    private manifest: any;
    private commands: Array<any>;

    constructor(app: any, manifest: any) {
        this.app = app;
        this.manifest = manifest;
  
        this.commands = [
            new CreateReadmeCommand(app, manifest),
            new CreateSettingsCommand(app, manifest),
            new CreateTemplatesCommand(app, manifest), 
        ];
    }

    public async execute(): Promise<void> { 
        for (const command of this.commands) {
            await command.execute();
        }
    }
}
