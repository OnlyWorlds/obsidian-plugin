import { Notice, Platform } from 'obsidian';
import { requestUrlFetch, signIn, signedInLabel } from './account-api';
import { openInBrowser } from '../Modals/SignInModal';
import { completeFromUrl, pendingStorage, receiveSchemeReturn, schemeReturnIsExpected, schemeReturnUrl, type BrowserSignInEnv, type Listen } from './browser-sign-in';

export interface BrowserHost {
	settings: { accountToken: string; accountUsername: string; pendingSignIn: string };
	saveSettings(): Promise<void>;
}

/**
 * What Sign in with your browser runs on: Obsidian's own request (the SDK's fetch
 * would be refused by the app's origin), the plugin's data for the parked record,
 * the system browser, and, on desktop only, the loopback listener. The listener
 * is a separate file loaded when it is needed, so the phone never loads Node's http.
 */
export function makeBrowserEnv(host: BrowserHost): BrowserSignInEnv {
	const listen: Listen | undefined = Platform.isMobile ? undefined : async (opts) => (await import('./loopback-listener')).listenOnce(opts);
	return {
		fetch: requestUrlFetch,
		storage: pendingStorage(host.settings, () => {
			host.saveSettings().catch(() => undefined);
		}),
		openUrl: openInBrowser,
		listen,
	};
}

/**
 * The obsidian://onlyworlds-signin return. Any website or program can open this link, so
 * nothing happens unless a sign-in started with this return is parked and the link carries its
 * state (the SDK would delete the parked record before judging a forged one). A dialog that is
 * waiting takes the address; with none (a phone that restarted Obsidian while the browser was
 * open) the parked record finishes the sign-in here, and a notice says how it went.
 */
export async function handleSchemeReturn(host: BrowserHost, params: Record<string, string>): Promise<void> {
	const url = schemeReturnUrl(params);
	if (!schemeReturnIsExpected(host.settings, url)) return;
	if (receiveSchemeReturn(url)) return;
	try {
		const token = await completeFromUrl(makeBrowserEnv(host), url);
		const username = await signIn(host, token);
		new Notice(signedInLabel(username));
	} catch (e) {
		new Notice(e instanceof Error ? e.message : String(e));
	}
}
