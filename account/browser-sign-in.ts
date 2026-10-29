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
 *
 * Where the pending record lives: on the loopback path it stays in memory (the
 * listener dies with the app, so a record that outlived it would be useless and
 * would ride Obsidian Sync); on the obsidian:// path it is kept in the plugin's
 * data, because a phone may suspend or restart Obsidian while the browser is open.
 */

export const SIGN_IN_CLIENT_ID = 'obsidian';
/** The loopback path and the protocol action, one word for both returns. */
export const SIGN_IN_ACTION = 'onlyworlds-signin';
export const SCHEME_RETURN = `obsidian://${SIGN_IN_ACTION}`;
/**
 * How long a started sign-in stays valid, in the listener, in the scheme wait and in
 * the parked record. Signing in on the website can mean a password manager, a reset,
 * two-factor or making an account.
 */
export const PENDING_MS = 5 * 60_000;
export const LISTEN_MS = PENDING_MS;

export const SIGN_IN_WAITING = 'Waiting for the browser. Finish signing in there, then come back to Obsidian.';
export const SIGN_IN_TIMEOUT = 'Sign in did not finish, so nothing was saved. Try again, or paste an account token.';
export const SIGN_IN_CANCELLED_IN_BROWSER = 'Sign in was cancelled in the browser, so nothing was saved.';

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

type Rec = { at: number; items: Record<string, string> };

function readRec(holder: PendingHolder): Rec {
	try {
		const p = JSON.parse(holder.pendingSignIn) as Rec;
		if (p && typeof p.at === 'number' && p.items && typeof p.items === 'object') return p;
	} catch {
		/* nothing parked */
	}
	return { at: 0, items: {} };
}

/**
 * Where the SDK parks the state and the PKCE verifier between the two steps. One
 * record, gone after `ttl` and on every outcome. `holder` is the plugin's data for
 * the obsidian:// path, or a throwaway object for the loopback path.
 */
export function pendingStorage(holder: PendingHolder, save: () => void, now: () => number = Date.now, ttl: number = PENDING_MS): PendingStorage {
	const write = (r: Rec): void => {
		holder.pendingSignIn = Object.keys(r.items).length ? JSON.stringify(r) : '';
		save();
	};
	return {
		get(key) {
			const r = readRec(holder);
			if (!Object.keys(r.items).length) return null;
			if (now() - r.at > ttl) {
				write({ at: 0, items: {} });
				return null;
			}
			return r.items[key] ?? null;
		},
		set(key, value) {
			const r = readRec(holder);
			r.items[key] = value;
			r.at = now();
			write(r);
		},
		remove(key) {
			const r = readRec(holder);
			delete r.items[key];
			write(r);
		},
		clear() {
			write({ at: 0, items: {} });
		},
	};
}

/** The sign-in parked in the plugin's data, if one is live: the state and the return it was started with. Reads only; the SDK would delete the record before judging it. */
export function peekPending(holder: PendingHolder, now: () => number = Date.now, ttl: number = PENDING_MS): { state: string; redirectUri: string } | null {
	const r = readRec(holder);
	if (!Object.keys(r.items).length || now() - r.at > ttl) return null;
	for (const v of Object.values(r.items)) {
		try {
			const p = JSON.parse(v) as { state?: unknown; redirectUri?: unknown };
			if (typeof p.state === 'string' && typeof p.redirectUri === 'string') return { state: p.state, redirectUri: p.redirectUri };
		} catch {
			/* not a sign-in record */
		}
	}
	return null;
}

// --- the words ------------------------------------------------------------

/** What went wrong, in the house words: it says what did not happen. */
export function signInFailure(e: unknown): Error {
	if (e instanceof OwSignInError) {
		if (e.reason === 'rate_limited') return new Error('Too many sign-in attempts, so nothing was saved. Try again in a minute.');
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
	/** Resolves with the address the browser came back to, once a request carries the expected state. */
	done: Promise<string>;
	/** Tell the listener which state to wait for. Until then every request is a 404. */
	expect(state: string): void;
	close(): void;
}
export type Listen = (opts: { timeoutMs: number }) => Promise<Listener>;

export interface BrowserSignInEnv {
	fetch: typeof fetch;
	/** The persisted record (the plugin's data), used on the obsidian:// path. */
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

/**
 * Finish with the address the browser came back to: the SDK checks state, the address and the code, and gives the token.
 * A return that says `error` (the person pressed Cancel on keel's page) ends the attempt in its own words.
 */
export async function completeFromUrl(env: Pick<BrowserSignInEnv, 'fetch'> & { storage: OwSignInStorage & { clear?(): void } }, url: string): Promise<string> {
	let page: URL | null = null;
	try {
		page = new URL(url);
	} catch {
		page = null;
	}
	if (page && page.searchParams.get('error') && !page.searchParams.get('code')) {
		env.storage.clear?.();
		throw new Error(SIGN_IN_CANCELLED_IN_BROWSER);
	}
	const client = new OwV2Client({ fetch: env.fetch });
	try {
		const r = await client.completeSignIn({ clientId: SIGN_IN_CLIENT_ID, url, storage: env.storage });
		return r.token;
	} catch (e) {
		throw signInFailure(e);
	}
}

/** A record that lives only as long as the attempt: the loopback path's. */
function memoryStorage(): PendingStorage {
	return pendingStorage({ pendingSignIn: '' }, () => undefined);
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
	const storage = listener ? memoryStorage() : env.storage;
	const redirectUri = listener ? loopbackReturn(listener.port) : SCHEME_RETURN;
	try {
		const begun = await client.signInWithOnlyWorlds({ clientId: SIGN_IN_CLIENT_ID, redirectUri, storage, navigate: false });
		listener?.expect(begun.state); // the listener answers only a request that carries this state
		env.openUrl(begun.url);
	} catch (e) {
		listener?.close();
		storage.clear();
		throw signInFailure(e);
	}
	if (!listener) {
		return { via: 'scheme', finished: null, cancel: () => storage.clear() };
	}
	const l = listener;
	const finished = l.done.then(
		(url) => completeFromUrl({ fetch: env.fetch, storage }, url),
		(e) => {
			storage.clear();
			throw signInFailure(e);
		}
	);
	return {
		via: 'loopback',
		finished,
		cancel: () => {
			l.close();
			storage.clear();
		},
	};
}

// --- the scheme return ----------------------------------------------------

let waiter: ((url: string) => void) | null = null;

/** A dialog waiting for the obsidian:// return: the address (rejecting with 'timeout' after `ms`), and a way to stop waiting. */
export function waitForSchemeReturn(ms: number = PENDING_MS): { url: Promise<string>; cancel(): void } {
	let mine: ((url: string) => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const url = new Promise<string>((resolve, reject) => {
		mine = (u) => {
			if (timer) clearTimeout(timer);
			resolve(u);
		};
		waiter = mine;
		timer = setTimeout(() => {
			if (waiter === mine) waiter = null;
			reject(new Error('timeout'));
		}, ms);
	});
	url.catch(() => undefined); // a wait nobody awaits any more is not an unhandled rejection
	return {
		url,
		cancel: () => {
			if (timer) clearTimeout(timer);
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

/**
 * Is this obsidian:// return one we are waiting for? The SDK deletes the parked record before it judges a
 * return, so a forged link must not reach it: the state has to be the parked one, on a sign-in started with
 * the obsidian:// return.
 */
export function schemeReturnIsExpected(holder: PendingHolder, url: string, now: () => number = Date.now): boolean {
	const parked = peekPending(holder, now);
	if (!parked || parked.redirectUri !== SCHEME_RETURN) return false;
	try {
		return new URL(url).searchParams.get('state') === parked.state;
	} catch {
		return false;
	}
}
