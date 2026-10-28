import { App, Notice } from 'obsidian';
import { signedInLabel } from './account-api';
import { SIGNUP_URL, SignInModal, openInBrowser, type SignInStore } from '../Modals/SignInModal';

export interface SignInHost extends SignInStore {
    app: App;
}

export const SIGNUP_OPENED = 'Opened the sign-up page. When you have an account, come back and run Sign in.';

/**
 * The one way in: the Sign in command, the Download dialog and the Create
 * world dialog all call this. Signed out, it opens the Sign in dialog and,
 * once the token is kept, calls `then` with the username. Signed in, it says
 * who is signed in and does nothing else.
 */
export function openSignIn(host: SignInHost, opts: { then?: (username: string) => void } = {}): void {
    if (host.settings.accountToken) {
        new Notice(signedInLabel(host.settings.accountUsername || 'your account'));
        return;
    }
    new SignInModal(host.app, host, opts.then).open();
}

/** Open the sign-up page in the browser, and say what comes next. */
export function openCreateAccount(): void {
    openInBrowser(SIGNUP_URL);
    new Notice(SIGNUP_OPENED);
}

/** The Sign in and Create account commands. */
export function registerAccountCommands(
    plugin: SignInHost & { addCommand(c: { id: string; name: string; callback: () => void }): unknown }
): void {
    plugin.addCommand({
        id: 'sign-in',
        name: 'Sign in',
        callback: () => openSignIn(plugin),
    });
    plugin.addCommand({
        id: 'create-account',
        name: 'Create account',
        callback: () => openCreateAccount(),
    });
}
