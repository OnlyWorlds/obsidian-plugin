import { requestUrl, RequestUrlParam } from "obsidian";
import { V2ApiError } from "../client-v2";

/**
 * Signing a vault in with an OnlyWorlds account (OW Infra #358).
 *
 * The credential is an account token (`ow_a_`, made on onlyworlds.com in
 * Account settings under Account tokens), sent as `Authorization: Bearer`. It
 * never goes on a world route: the account lists its worlds, and each world
 * this vault downloads gets its own key, minted on the account and named for
 * the vault, which then works like any pasted key (World.md, Save Element,
 * auto-sync, the PIN asked only for a write).
 *
 * Routes, as keel's OpenAPI document declares them (accounts/api.py):
 *   GET  /api/v2/account                        the profile (username)
 *   GET  /api/v2/account/worlds                 owned and member worlds
 *   POST /api/v2/account/worlds                 create a world {name, pin?}
 *   POST /api/v2/account/worlds/{id}/keys       mint a key {scope, name}; for a
 *        member keel binds it to their own membership (409 pin_required when a
 *        member without an account PIN asks for a write key)
 *
 * Reference: Lantern's src/account.ts (Forge), which does the same on a phone.
 */

export const API_V2 = "https://www.onlyworlds.com/api/v2";

export interface AccountWorldKey {
	name: string;
	last4: string;
	scope: string;
	revoked: boolean;
}

export interface AccountWorld {
	id: string;
	name: string;
	/** keel's recorded value: "owner", or "collaborator" for a membership. */
	role: "owner" | "collaborator";
	/** A membership's role; absent for the owner. A guest is a player. */
	member_role?: "co_builder" | "contributor" | "guest";
	public_read?: boolean;
	/** last4s only (a member sees only their own keys); never a full key. */
	keys?: AccountWorldKey[];
}

export interface MintedKey {
	key: string;
	/** The key's id on the account (for revoking it), when keel says it. */
	id?: string;
	scope: "write" | "read";
	/** A member whose account has no PIN yet: keel refused the write key, so this one reads. */
	readForWantOfPin: boolean;
}

/** How owRequest waits before its one retry; tests replace `sleep`. */
export const owTiming = {
	sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RETRY_CAP_MS = 10_000;

/** Retry-After as milliseconds (seconds or an HTTP date), capped at 10 s; null when absent or unreadable. */
export function retryAfterMs(headers: Record<string, string> | undefined): number | null {
	if (!headers) return null;
	const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === "retry-after")?.[1];
	if (raw === undefined || String(raw).trim() === "") return null;
	const s = String(raw).trim();
	let ms: number;
	if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
	else {
		const at = Date.parse(s);
		if (Number.isNaN(at)) return null;
		ms = at - Date.now();
	}
	return Math.min(Math.max(0, ms), RETRY_CAP_MS);
}

/**
 * One request to keel's v2 surface over Obsidian's requestUrl. Errors are
 * keel's envelope, as V2ApiError. A 429 or 503 that carries Retry-After is
 * retried once after that wait, capped at 10 s (Kael's review).
 */
export async function owRequest<T>(
	method: string,
	path: string,
	opts: { token?: string; body?: unknown } = {}
): Promise<T> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const req: RequestUrlParam = { url: `${API_V2}${path}`, method, headers, throw: false };
	if (opts.body !== undefined) req.body = JSON.stringify(opts.body);

	let response = await requestUrl(req);
	if (response.status === 429 || response.status === 503) {
		const wait = retryAfterMs(response.headers);
		if (wait !== null) {
			await owTiming.sleep(wait);
			response = await requestUrl(req);
		}
	}
	if (response.status >= 400) {
		let code = `http_${response.status}`;
		let message = `API error ${response.status}`;
		let docUrl: string | null = null;
		let param: string | null = null;
		try {
			const parsed = JSON.parse(response.text) as {
				error?: { code?: string; message?: string; doc_url?: string; param?: string };
			} | null;
			const e = parsed && typeof parsed === "object" ? parsed.error : undefined;
			if (e) {
				code = e.code ?? code;
				message = e.message ?? message;
				docUrl = e.doc_url ?? null;
				param = e.param ?? null;
			}
		} catch {
			/* not keel's envelope: the status says enough */
		}
		const err = new V2ApiError(response.status, code, message, docUrl);
		(err as V2ApiError & { param: string | null }).param = param;
		throw err;
	}
	if (response.status === 204) return undefined as unknown as T;
	return response.json as T;
}

export function isAccountToken(token: string): boolean {
	return token.trim().startsWith("ow_a_");
}

export const NOT_A_TOKEN = "That is not an account token. Account tokens start with ow_a_.";

function networkWords(e: unknown, fallback: string): Error {
	if (e instanceof V2ApiError) {
		if (e.status === 401) return new Error("OnlyWorlds does not know that token: it was revoked, or copied wrong. Make a new one on onlyworlds.com, in Account settings under Account tokens.");
		if (e.status === 429) return new Error("Too many requests. Try again in a minute.");
		return new Error(e.message || fallback);
	}
	if (e instanceof Error && e.message) return new Error(`${fallback} (${e.message})`);
	return new Error(fallback);
}

/** Check a token against keel (GET /account) and say who it is. Sends nothing for a non-token. */
export async function checkAccountToken(token: string): Promise<{ username: string }> {
	const t = token.trim();
	if (!isAccountToken(t)) throw new Error(NOT_A_TOKEN);
	let me: { username?: string };
	try {
		me = await owRequest<{ username?: string }>("GET", "/account", { token: t });
	} catch (e) {
		throw networkWords(e, "Signing in did not work. Try again.");
	}
	return { username: me?.username || "your account" };
}

export function signedInLabel(username: string): string {
	return `Signed in as ${username}`;
}

interface AccountStore {
	settings: { accountToken: string; accountUsername: string };
	saveSettings(): Promise<void>;
}

/** Check the token, then keep it and its username. Nothing is kept for a token keel refuses. */
export async function signIn(store: AccountStore, token: string): Promise<string> {
	const t = token.trim();
	const { username } = await checkAccountToken(t);
	store.settings.accountToken = t;
	store.settings.accountUsername = username;
	await store.saveSettings();
	return username;
}

/**
 * Where the token lives, said under it in settings (Kael's review 3.3).
 * Obsidian's SecretStorage (app.secretStorage) arrived in 1.11.4 and this
 * plugin's minAppVersion is 1.4.0, so the token stays in plugin data, and the
 * user is told so, and sign-out revokes it.
 */
export const TOKEN_STORAGE_NOTE =
	"The token is stored in this vault's plugin data (data.json), which Obsidian Sync and git carry with the vault. " +
	"Signing out revokes it on onlyworlds.com.";

/**
 * Forget the token, then revoke it on onlyworlds.com (best effort: GET
 * /account/tokens, the row with its last four, DELETE it, the token itself as
 * the Bearer). The token is forgotten even when the revoke fails, and the
 * message says to revoke it by hand. The world keys already in World.md stay:
 * they are the worlds', not the token's.
 */
export async function signOut(store: AccountStore): Promise<{ revoked: boolean; message: string }> {
	const token = store.settings.accountToken.trim();
	store.settings.accountToken = "";
	store.settings.accountUsername = "";
	await store.saveSettings();
	const byHand =
		"Signed out. The token could not be revoked from here: revoke it on onlyworlds.com, in Account settings under Account tokens.";
	if (!isAccountToken(token)) return { revoked: false, message: byHand };
	try {
		const listed = await owRequest<{ data?: Array<{ id: string; last4: string; revoked: boolean }> }>("GET", "/account/tokens", { token });
		const mine = (listed?.data ?? []).filter((t) => !t.revoked && t.last4 === token.slice(-4));
		if (mine.length !== 1) return { revoked: false, message: byHand };
		await owRequest("DELETE", `/account/tokens/${encodeURIComponent(mine[0].id)}`, { token });
		return { revoked: true, message: "Signed out, and the token was revoked on onlyworlds.com." };
	} catch {
		return { revoked: false, message: byHand };
	}
}

export async function listAccountWorlds(token: string): Promise<AccountWorld[]> {
	try {
		const res = await owRequest<{ data?: AccountWorld[] }>("GET", "/account/worlds", { token });
		return Array.isArray(res?.data) ? res.data : [];
	} catch (e) {
		throw networkWords(e, "Your worlds could not be read. Try again.");
	}
}

/** The role in words, as the world list shows it. */
export function roleWords(w: AccountWorld): string {
	if (w.role === "owner") return "Owner";
	if (w.member_role === "co_builder") return "Co-builder";
	if (w.member_role === "contributor") return "Contributor";
	if (w.member_role === "guest") return "Player";
	return "Member";
}

/** The name a minted key carries on the account's keys page, so it can be found and revoked there. */
export function vaultKeyName(vaultName: string): string {
	return `obsidian: ${vaultName}`;
}

/**
 * Mint this vault's key for a world on the account: a write key for an owner,
 * a co-builder or a contributor (keel binds a member's key to their own
 * membership on the same route), a read key for a player (guest). A member
 * whose account has no PIN yet is refused a write key (409 pin_required) and
 * reads until they set one, as on Lantern.
 */
export async function mintVaultKey(token: string, world: AccountWorld, vaultName: string): Promise<MintedKey> {
	const name = vaultKeyName(vaultName);
	const path = `/account/worlds/${encodeURIComponent(world.id)}/keys`;
	const mint = async (scope: "write" | "read", readForWantOfPin: boolean): Promise<MintedKey> => {
		const k = await owRequest<{ key: string; id?: string }>("POST", path, { token, body: { scope, name } });
		return { key: k.key, id: k.id, scope, readForWantOfPin };
	};
	if (world.member_role === "guest") return mint("read", false);
	try {
		return await mint("write", false);
	} catch (e) {
		if (e instanceof V2ApiError && e.code === "pin_required" && world.role !== "owner") {
			return mint("read", true);
		}
		throw networkWords(e, `A key for ${world.name} could not be made. Try again.`);
	}
}

/** True when the account's role on `world` can write: the owner, a co-builder, a contributor. */
export function canWrite(world: AccountWorld): boolean {
	return world.role === "owner" || world.member_role === "co_builder" || world.member_role === "contributor";
}

/**
 * Mint a WRITE key for this vault, or null when keel refuses it for want of an
 * account PIN (409 pin_required). Never falls back to a read key: the caller
 * already holds one (Kael's review 3.2).
 */
export async function mintWriteKey(token: string, world: AccountWorld, vaultName: string): Promise<MintedKey | null> {
	const path = `/account/worlds/${encodeURIComponent(world.id)}/keys`;
	try {
		const k = await owRequest<{ key: string; id?: string }>("POST", path, {
			token,
			body: { scope: "write", name: vaultKeyName(vaultName) },
		});
		return { key: k.key, id: k.id, scope: "write", readForWantOfPin: false };
	} catch (e) {
		if (e instanceof V2ApiError && e.code === "pin_required") return null;
		throw networkWords(e, `A key for ${world.name} could not be made. Try again.`);
	}
}

/**
 * Revoke one of the account's keys on `worldId`: by its id when known, else
 * every live key with this last4 (and scope, when given) except `keepId`.
 * Returns how many were revoked; 0 when the account does not list the key
 * (a player link's key is the link's, not the account's).
 */
export async function revokeAccountKey(
	token: string,
	worldId: string,
	match: { id?: string; last4?: string; scope?: "read" | "write" },
	keepId?: string
): Promise<number> {
	const path = `/account/worlds/${encodeURIComponent(worldId)}/keys`;
	if (match.id) {
		await owRequest("DELETE", `${path}/${encodeURIComponent(match.id)}`, { token });
		return 1;
	}
	const listed = await owRequest<{ data?: Array<{ id: string; last4: string; scope?: string; revoked: boolean }> }>("GET", path, { token });
	let n = 0;
	for (const k of listed?.data ?? []) {
		if (k.revoked || k.id === keepId || k.last4 !== match.last4) continue;
		if (match.scope && k.scope && k.scope.toLowerCase() !== match.scope) continue;
		await owRequest("DELETE", `${path}/${encodeURIComponent(k.id)}`, { token });
		n++;
	}
	return n;
}

/** POST /account/worlds's 201: the world row (keys as last4s) and its write key, shown once. */
export interface CreatedWorld {
	id: string;
	name: string;
	key?: string;
	keys?: AccountWorldKey[];
}

/** A full write key's secret, as keel shows it once (ow_w_ and more than a prefix). */
export function isFullWriteKey(key: unknown): key is string {
	return typeof key === "string" && /^ow_w_\S{4,}$/.test(key);
}

/**
 * Revoke the keys of a just-created world that are not `keepId`: those whose
 * last4 the create answer listed or its full key ends in (the create route's
 * own key, which keel names nothing). Called once the vault's own key, named
 * for the vault, is in World.md.
 */
export async function revokeCreateKeys(token: string, created: CreatedWorld, keepId: string | undefined): Promise<number> {
	const last4s = (created.keys ?? []).map((k) => k.last4);
	if (isFullWriteKey(created.key)) last4s.push(created.key.slice(-4));
	const path = `/account/worlds/${encodeURIComponent(created.id)}/keys`;
	const listed = await owRequest<{ data?: Array<{ id: string; last4: string; revoked: boolean }> }>("GET", path, { token });
	let n = 0;
	for (const k of listed?.data ?? []) {
		if (k.revoked || k.id === keepId || !last4s.includes(k.last4)) continue;
		await owRequest("DELETE", `${path}/${encodeURIComponent(k.id)}`, { token });
		n++;
	}
	return n;
}

export const NO_PIN_YET =
	"Your account has no PIN yet, so this vault reads the world for now. Set a PIN on onlyworlds.com, in Account settings, then download the world again to write.";

export const REVOKE_BY_HAND = (world: string) =>
	`The old read key for ${world} could not be revoked from here: revoke it on onlyworlds.com, in Account settings under the world's keys.`;

/**
 * Create a world on the account (POST /account/worlds). keel wants `pin` only
 * from an account that has none yet (it becomes the account PIN) and refuses
 * it from one that has (422, param pin both ways), so the PIN is sent only
 * when keel says the account has none.
 */
export async function createAccountWorld(
	token: string,
	name: string,
	pin: string
): Promise<CreatedWorld> {
	type Created = CreatedWorld;
	try {
		return await owRequest<Created>("POST", "/account/worlds", { token, body: { name } });
	} catch (e) {
		const param = (e as { param?: string | null }).param;
		if (e instanceof V2ApiError && e.status === 422 && param === "pin" && pin) {
			try {
				return await owRequest<Created>("POST", "/account/worlds", { token, body: { name, pin } });
			} catch (e2) {
				throw networkWords(e2, "The world could not be created. Try again.");
			}
		}
		throw networkWords(e, "The world could not be created. Try again.");
	}
}
