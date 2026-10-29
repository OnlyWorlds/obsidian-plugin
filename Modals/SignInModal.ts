import { App, Modal, Notice } from 'obsidian';
import { applyMobileModal, suppressAutofocus } from './mobile';
import { TOKEN_STORAGE_NOTE, signIn, signedInLabel } from '../account/account-api';
import { SIGN_IN_WAITING, beginBrowserSignIn, completeFromUrl, waitForSchemeReturn, type BrowserSignInEnv } from '../account/browser-sign-in';

/** Account settings on onlyworlds.com; a signed-out visitor goes through the login page and back. */
export const ACCOUNT_SETTINGS_URL = 'https://www.onlyworlds.com/account/settings';
/** The sign-up page: the Create account command and the dialog's second link. */
export const SIGNUP_URL = 'https://www.onlyworlds.com/accounts/signup/';

export const SIGN_IN_HINT = 'Paste an account token. Make one on onlyworlds.com, in Account settings under Account tokens.';
export const BROWSER_BUTTON = 'Sign in with your browser';
export const BROWSER_HINT = 'Opens onlyworlds.com in your browser and brings the sign-in back here.';

/** Open an address in the browser. No Node or Electron API, so it works on mobile too. */
export function openInBrowser(url: string): void {
    window.open(url, '_blank');
}

export interface SignInStore {
    settings: { accountToken: string; accountUsername: string };
    saveSettings(): Promise<void>;
    /** Present when the vault can sign in through the browser; a store without it shows the paste field alone. */
    browserEnv?(): BrowserSignInEnv | null;
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
    private cancelBrowser: (() => void) | null = null;
    private closed = false;
    private finishing = false;

    constructor(app: App, store: SignInStore, then?: (username: string) => void) {
        super(app);
        this.store = store;
        this.then = then ?? null;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('ow-sign-in-modal');
        contentEl.createEl('h3', { text: 'Sign in to OnlyWorlds' });
        const browserEnv = this.store.browserEnv?.();
        let browserButton: HTMLButtonElement | null = null;
        if (browserEnv) {
            browserButton = contentEl.createEl('button', { text: BROWSER_BUTTON, cls: 'ow-sign-in-browser' });
            contentEl.createEl('p', { text: BROWSER_HINT, cls: 'ow-account-hint' });
        }
        contentEl.createEl('p', { text: SIGN_IN_HINT, cls: 'ow-account-hint' });

        const tokenInput = contentEl.createEl('input', {
            type: 'password',
            placeholder: 'ow_a_…',
            cls: 'ow-sign-in-token',
        });
        contentEl.createEl('p', { text: TOKEN_STORAGE_NOTE, cls: 'ow-account-hint' });
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
        if (browserEnv && browserButton) {
            const button = browserButton;
            button.addEventListener('click', () => {
                void this.browserSignIn(browserEnv, button, message);
            });
        }
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

    /**
     * Sign in with your browser: keel's sign-in page in the system browser, the
     * token coming back through the loopback (desktop) or the obsidian:// return,
     * then kept by signIn as a pasted one is. The dialog waits, says so, and Cancel
     * or closing it ends the wait and clears what was parked.
     */
    private async browserSignIn(env: BrowserSignInEnv, button: HTMLButtonElement, message: HTMLElement): Promise<void> {
        button.disabled = true;
        message.setText('');
        const scheme = waitForSchemeReturn(); // listening before the browser is sent, so a fast return cannot be missed
        try {
            const session = await beginBrowserSignIn(env);
            if (session.via === 'loopback') scheme.cancel();
            this.cancelBrowser = () => {
                session.cancel();
                scheme.cancel();
            };
            if (this.closed) {
                this.cancelBrowser(); // the dialog was closed while the sign-in was starting: stop it
                return;
            }
            message.setText(SIGN_IN_WAITING);
            const token = session.finished ? await session.finished : await completeFromUrl(env, await scheme.url);
            if (this.closed) return; // closed while waiting: the sign-in was stopped, keep nothing
            const username = await signIn(this.store, token);
            new Notice(signedInLabel(username));
            this.cancelBrowser = null;
            const dismissed = this.closed; // closed while signIn was running: the person is signed in, but the flow that asked is not resumed
            this.finishing = true;
            this.close();
            if (!dismissed) this.then?.(username);
        } catch (e) {
            scheme.cancel();
            this.cancelBrowser = null;
            message.setText(e instanceof Error ? e.message : String(e));
            button.disabled = false;
        }
    }

    onClose(): void {
        if (!this.finishing) this.closed = true;
        this.cancelBrowser?.();
        this.cancelBrowser = null;
        this.contentEl.empty();
    }
}
