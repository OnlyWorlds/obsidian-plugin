import { OwSignInError, OwV2Client, type OwSignInStorage } from '@onlyworlds/sdk';

/**
 * Sign in with your browser: OnlyWorlds' own sign-in page in the system browser,
 * and the account token coming back to the vault. keel lists this plugin as a
 * native client (GET /api/v2/auth/clients): id `obsidian`, returns
 * http://127.0.0.1/onlyworlds-signin (any port at run time) and
 * obsidian://onlyworlds-signin. The SDK (4.104.0) does the PKCE, the state and
 * the token exchange; this file picks the return, keeps the pending record
 * between the two steps and says what went wrong in the house words.
 *
 * Pure: no Obsidian and no Node import, so the tests run it as it is and the
 * phone loads it. The desktop loopback listener is account/loopback-listener.ts.
 */

export const SIGN_IN_CLIENT_ID = 'obsidian';
/** The loopback path and the protocol action, one word for both returns. */
export const SIGN_IN_ACTION = 'onlyworlds-signin';
export const SCHEME_RETURN = `obsidian://${SIGN_IN_ACTION}`;
/** How long the desktop listener waits for the browser to come back. */
export const LISTEN_MS = 60_000;
/** How long a started sign-in stays valid (a phone may take longer to come back). */
export const PENDING_MS = 5 * 60_000;

export const SIGN_IN_WAITING = 'Waiting for the browser. Finish signing in there, then come back to Obsidian.';
export const SIGN_IN_TIMEOUT = 'Sign in did not finish, so nothing was saved. Try again, or paste an account token.';

/** The loopback return with the port the listener bound for this sign-in. */
export function loopbackReturn(port: number): string {
	return `http://127.0.0.1:${port}/${SIGN_IN_ACTION}`;
}

/**
 * The address Obsidian's protocol handler received, rebuilt as the string the
 * SDK compares: the action is the address, the other parameters its query.
 */
export function schemeReturnUrl(params: Record<string, string>): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (k !== 'action' && typeof v === 'string') q.set(k, v);
	}
	const s = q.toString();
	return s ? `${SCHEME_RETURN}?${s}` : SCHEME_RETURN;
}

// --- the pending record ---------------------------------------------------

export interface PendingHolder {
	pendingSignIn: string;
}

export type PendingStorage = OwSignInStorage & { clear(): void };

/**
 * Where the SDK parks the state and the PKCE verifier between the two steps: the
 * plugin's own data, so a phone that suspends Obsidian while the browser is open
 * still finds them. One record, gone after `ttl` and on every outcome.
 */
export function pendingStorage(holder: PendingHolder, save: () => void, now: () => number = Date.now, ttl: number = PENDING_MS): PendingStorage {
	type Rec = { at: number; items: Record<string, string> };
	const read = (): Rec => {
		try {
			const p = JSON.parse(holder.pendingSignIn) as Rec;
			if (p && typeof p.at === 'number' && p.items && typeof p.items === 'object') return p;
		} catch {
			/* nothing parked */
		}
		return { at: 0, items: {} };
	};
	const write = (r: Rec): void => {
		holder.pendingSignIn = Object.keys(r.items).length ? JSON.stringify(r) : '';
		save();
	};
	return {
		get(key) {
			const r = read();
			if (!Object.keys(r.items).length) return null;
			if (now() - r.at > ttl) {
				write({ at: 0, items: {} });
				return null;
			}
			return r.items[key] ?? null;
		},
		set(key, value) {
			const r = read();
			r.items[key] = value;
			r.at = now();
			write(r);
		},
		remove(key) {
			const r = read();
			delete r.items[key];
			write(r);
		},
		clear() {
			write({ at: 0, items: {} });
		},
	};
}

// --- the words ------------------------------------------------------------

/** What went wrong, in the house words: it says what did not happen. */
export function signInFailure(e: unknown): Error {
	if (e instanceof OwSignInError) {
		if (e.reason === 'rate_limited') return new Error('Too many requests. Try again in a minute.');
		if (e.reason === 'offline') return new Error('OnlyWorlds could not be reached, so nothing was saved.');
		return new Error('OnlyWorlds did not accept that sign-in, so nothing was saved. Try again.');
	}
	if (e instanceof Error && e.message && e.message !== 'timeout' && e.message !== 'cancelled') return e;
	return new Error(SIGN_IN_TIMEOUT);
}

// --- the two steps --------------------------------------------------------

/** A one-request loopback listener (desktop): the port it bound, and the address the browser came back to. */
export interface Listener {
	port: number;
	done: Promise<string>;
	close(): void;
}
export type Listen = (opts: { timeoutMs: number }) => Promise<Listener>;

export interface BrowserSignInEnv {
	fetch: typeof fetch;
	storage: PendingStorage;
	openUrl(url: string): void;
	/** Desktop only. Absent on mobile; a refusal to bind falls back to the obsidian:// return. */
	listen?: Listen;
}

export interface BrowserSignInSession {
	via: 'loopback' | 'scheme';
	/** The account token, from the loopback; null for the scheme return, which arrives through the protocol handler. */
	finished: Promise<string> | null;
	cancel(): void;
}

/** Finish with the address the browser came back to: the SDK checks state, the address and the code, and gives the token. */
export async function completeFromUrl(env: Pick<BrowserSignInEnv, 'fetch' | 'storage'>, url: string): Promise<string> {
	const client = new OwV2Client({ fetch: env.fetch });
	try {
		const r = await client.completeSignIn({ clientId: SIGN_IN_CLIENT_ID, url, storage: env.storage });
		return r.token;
	} catch (e) {
		throw signInFailure(e);
	}
}

/** Start: bind the loopback where there is one, send the browser to keel's sign-in page, and say how the answer will arrive. */
export async function beginBrowserSignIn(env: BrowserSignInEnv): Promise<BrowserSignInSession> {
	const client = new OwV2Client({ fetch: env.fetch });
	let listener: Listener | null = null;
	if (env.listen) {
		try {
			listener = await env.listen({ timeoutMs: LISTEN_MS });
		} catch {
			listener = null;
		}
	}
	const redirectUri = listener ? loopbackReturn(listener.port) : SCHEME_RETURN;
	try {
		await client.signInWithOnlyWorlds({ clientId: SIGN_IN_CLIENT_ID, redirectUri, storage: env.storage, navigate: env.openUrl });
	} catch (e) {
		listener?.close();
		env.storage.clear();
		throw signInFailure(e);
	}
	if (!listener) {
		return { via: 'scheme', finished: null, cancel: () => env.storage.clear() };
	}
	const l = listener;
	const finished = l.done.then(
		(url) => completeFromUrl(env, url),
		(e) => {
			env.storage.clear();
			throw signInFailure(e);
		}
	);
	return {
		via: 'loopback',
		finished,
		cancel: () => {
			l.close();
			env.storage.clear();
		},
	};
}

// --- the scheme return ----------------------------------------------------

let waiter: ((url: string) => void) | null = null;

/** A dialog waiting for the obsidian:// return: the address, and a way to stop waiting. */
export function waitForSchemeReturn(): { url: Promise<string>; cancel(): void } {
	let mine: ((url: string) => void) | null = null;
	const url = new Promise<string>((resolve) => {
		mine = resolve;
		waiter = resolve;
	});
	return {
		url,
		cancel: () => {
			if (waiter === mine) waiter = null;
		},
	};
}

/** The protocol handler hands the returned address here first: true when a dialog was waiting and took it. */
export function receiveSchemeReturn(url: string): boolean {
	if (!waiter) return false;
	const w = waiter;
	waiter = null;
	w(url);
	return true;
}
