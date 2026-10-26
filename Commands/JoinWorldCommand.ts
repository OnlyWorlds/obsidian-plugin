import { App, Notice } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import type { DownloadWorldCommand } from './DownloadWorldCommand';
import { listAccountWorlds, type AccountWorld } from '../account/account-api';
import {
    AGENT_LINK,
    NO_CODE,
    SIGN_IN_FIRST,
    acceptJoin,
    inviteWords,
    joinCode,
    joinKeyWords,
    previewJoin,
    redeemPlayer,
} from '../account/join';
import { JoinConfirmModal, JoinLinkModal } from '../Modals/JoinWorldModal';

/**
 * "Join a world with a link". The link (or its bare code) is
 * previewed first, with no credential, and said: who invites, to which world,
 * as what. Then, by whose code it is:
 *   - person: accepted into the signed-in account, then downloaded as from
 *     the account (a key minted for this vault). Not signed in: sign in first.
 *   - player: redeemed with no account; keel answers with a read key, and the
 *     world downloads read-only with it.
 *   - agent: refused here, in words: it is for an AI, not a vault.
 */
export class JoinWorldCommand {
    constructor(private app: App, private plugin: OnlyWorldsPlugin, private download: DownloadWorldCommand) {}

    execute(): void {
        new JoinLinkModal(this.app, (input) => {
            void this.joinWith(input, (words, detail) => this.confirm(words, detail));
        }).open();
    }

    private confirm(words: string, detail: string): Promise<boolean> {
        return new Promise((resolve) => new JoinConfirmModal(this.app, words, detail, resolve).open());
    }

    /** The whole join, with the confirmation asked through `confirm` (a modal in Obsidian). */
    async joinWith(input: string, confirm: (words: string, detail: string) => Promise<boolean>): Promise<void> {
        const code = joinCode(input);
        if (!code) {
            new Notice(NO_CODE, 8000);
            return;
        }
        let preview;
        try {
            preview = await previewJoin(code);
        } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e), 10000);
            return;
        }

        if (preview.reader === 'agent') {
            new Notice(AGENT_LINK, 10000);
            return;
        }

        const words = inviteWords(preview);
        const token = this.plugin.settings.accountToken;

        if (preview.reader === 'player') {
            const ok = await confirm(words, 'You read the world as your Character; nothing is written from this vault. Each link works once.');
            if (!ok) return;
            let seat;
            try {
                seat = await redeemPlayer(code);
            } catch (e) {
                new Notice(e instanceof Error ? e.message : String(e), 10000);
                return;
            }
            // The key is shown once and the code is spent: download with it now,
            // and its World.md keeps it.
            const folder = await this.download.downloadWithKey(seat.key, '');
            if (!folder) {
                new Notice(`Your read key for ${seat.world.name}, shown once by onlyworlds.com, in case the download needs trying again: ${seat.key}`, 0);
            }
            return;
        }

        if (preview.reader !== 'person') {
            new Notice('This link is of a kind this plugin does not know yet. Update the plugin, or open the link on onlyworlds.com.', 10000);
            return;
        }

        if (!token) {
            new Notice(`${words} ${SIGN_IN_FIRST}`, 10000);
            return;
        }
        const ok = await confirm(words, `You join as ${this.plugin.settings.accountUsername || 'your account'}. ${joinKeyWords(preview.role)}`);
        if (!ok) return;

        let joined;
        try {
            joined = await acceptJoin(token, code);
        } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e), 10000);
            return;
        }

        let worlds: AccountWorld[];
        try {
            worlds = await listAccountWorlds(token);
        } catch (e) {
            new Notice(`You joined, but your worlds could not be read here. Use Download world. (${e instanceof Error ? e.message : String(e)})`, 10000);
            return;
        }
        // A 409 already_member names no world: find it by the preview's name, when only one fits.
        const world = joined.already
            ? onlyOne(worlds.filter((w) => w.name === preview.world.name))
            : worlds.find((w) => w.id === joined.world_id) ?? null;
        if (joined.already) new Notice(`You are a member of ${preview.world.name} already.`, 6000);
        if (!world) {
            new Notice(`${preview.world.name} is on your account; download it with Download world.`, 10000);
            return;
        }
        await this.download.downloadAccountWorld(world);
    }
}

function onlyOne<T>(xs: T[]): T | null {
    return xs.length === 1 ? xs[0] : null;
}
