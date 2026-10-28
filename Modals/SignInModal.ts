import { App, Modal, Notice } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';
import { signIn, signedInLabel } from '../account/account-api';

/** Account settings on onlyworlds.com; a signed-out visitor goes through the login page and back. */
export const ACCOUNT_SETTINGS_URL = 'https://www.onlyworlds.com/account/settings';
/** The sign-up page: the Create account command and the dialog's second link. */
export const SIGNUP_URL = 'https://www.onlyworlds.com/accounts/signup/';

export const SIGN_IN_HINT = 'Paste an account token. Make one on onlyworlds.com, in Account settings under Account tokens.';

/** Open an address in the browser. No Node or Electron API, so it works on mobile too. */
export function openInBrowser(url: string): void {
    window.open(url, '_blank');
}

export interface SignInStore {
    settings: { accountToken: string; accountUsername: string };
    saveSettings(): Promise<void>;
}

/**
 * Sign in to OnlyWorlds: an account token pasted into one field, checked and
 * kept by signIn (account-api.ts), as the Settings tab does it. On success the
 * dialog closes with the Settings tab's notice and calls `then` with the
 * username. A refused token's message is shown in the dialog, which stays open.
 */
export class SignInModal extends Modal {
    private store: SignInStore;
    private then: ((username: string) => void) | null;

    constructor(app: App, store: SignInStore, then?: (username: string) => void) {
        super(app);
        this.store = store;
        this.then = then ?? null;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ow-sign-in-modal');
        contentEl.createEl('h3', { text: 'Sign in to OnlyWorlds' });
        contentEl.createEl('p', { text: SIGN_IN_HINT, cls: 'ow-account-hint' });

        const tokenInput = contentEl.createEl('input', {
            type: 'password',
            placeholder: 'ow_a_…',
            cls: 'ow-sign-in-token',
        });
        const message = contentEl.createEl('p', { cls: 'ow-sign-in-message' });

        const links = contentEl.createDiv({ cls: 'ow-sign-in-links' });
        const link = (text: string, url: string) => {
            const a = links.createEl('a', { text, href: url });
            a.addEventListener('click', (evt: MouseEvent) => {
                evt.preventDefault();
                openInBrowser(url);
            });
        };
        link('Open Account settings', ACCOUNT_SETTINGS_URL);
        link('Make a free account', SIGNUP_URL);

        const buttons = contentEl.createDiv({ cls: 'ow-sign-in-buttons' });
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.close());
        const submit = buttons.createEl('button', { text: 'Sign in', cls: 'mod-cta' });
        const go = () => {
            void this.submit(tokenInput.value, submit, message);
        };
        submit.addEventListener('click', go);
        tokenInput.addEventListener('keydown', (evt: KeyboardEvent) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                go();
            }
        });

        if (!suppressAutofocus()) tokenInput.focus();
        applyMobileModal(this);
    }

    private async submit(token: string, button: HTMLButtonElement, message: HTMLElement): Promise<void> {
        button.disabled = true;
        message.setText('');
        try {
            const username = await signIn(this.store, token);
            new Notice(signedInLabel(username));
            this.close();
            this.then?.(username);
        } catch (e) {
            message.setText(e instanceof Error ? e.message : String(e));
            button.disabled = false;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
