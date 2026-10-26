import { V2ApiError } from "../client-v2";
import { owRequest } from "./account-api";

/**
 * Joining a world with a link: https://www.onlyworlds.com/join#ow_j_…,
 * the code after the #. Routes as keel's OpenAPI document declares them
 * (accounts/join_api.py, accounts/api.py):
 *
 *   POST /api/v2/join/preview   {code}  no credential; the code stays unused.
 *        `reader` says whose code it is: person, player or agent.
 *   POST /api/v2/account/join   {code}  Bearer ow_a_: a person code becomes a
 *        membership of the signed-in account (201 the joined row; 409
 *        already_member, the code not spent).
 *   POST /api/v2/join           {code}  no credential: a player code answers
 *        201 `kind: player` with a read key (ow_r_), shown once; the code is spent.
 *
 * Reference: Lantern's src/join.ts.
 */

export interface JoinPreview {
	/** "person", "player" or "agent"; another value is a reader this plugin does not know yet. */
	reader: string;
	world: { name: string; description: string };
	invited_by: string | null;
	owner_character: string | null;
	role: string;
	with_character: boolean;
	expires_at: string;
}

export interface JoinedMembership {
	world_id: string;
	world_name: string;
	role: string;
	/** True when the account was a member already (409): nothing new was made. */
	already: boolean;
}

export interface PlayerSeat {
	key: string;
	world: { id: string; name: string };
	character: { id: string; name: string } | null;
}

export const DEAD_LINK = "This invite link does not work: it was used, it expired, or it was taken back. Ask for a new one.";
export const AGENT_LINK = "This link is for an AI agent, not a vault. Give it to the agent it was made for.";
export const SIGN_IN_FIRST = "This link joins an OnlyWorlds account. Sign in first (Settings, OnlyWorlds account), then open the link again.";
export const NO_CODE = "That is not a join link. A join link looks like https://www.onlyworlds.com/join#ow_j_…";

/** The code inside a pasted link, a shared message, or the bare code. */
export function joinCode(input: string): string | null {
	return input.match(/ow_j_[A-Za-z0-9_-]+/)?.[0] ?? null;
}

/** "a co-builder": the role as the invite sentence says it. */
export function joinRoleWords(role: string): string {
	if (role === "guest") return "a player";
	if (role === "co_builder") return "a co-builder";
	if (role === "contributor") return "a contributor";
	return role ? `a ${role.replace(/_/g, "-")}` : "a member";
}

/**
 * What the joining vault's key can do, by the invite's role: a guest (a
 * player) gets a read key (mintVaultKey mints read for a guest), every other
 * role a write key. Said before the join, so a read key is not a surprise
 * (Seethe's walk of rc-next, 2026-10-17).
 */
export function joinKeyWords(role: string): string {
	if (role === "guest") return "This vault then downloads the world with its own read key: you can read it here, not change it.";
	return "This vault then downloads the world with its own key.";
}

/** "Ana invites you to Sikelia as a co-builder." */
export function inviteWords(p: JoinPreview): string {
	const who = p.invited_by?.trim() || p.owner_character?.trim() || "Someone";
	const world = p.world?.name?.trim() || "a world";
	return `${who} invites you to ${world} as ${joinRoleWords(p.role)}.`;
}

function words(e: unknown, fallback: string): Error {
	if (e instanceof V2ApiError) {
		if (e.status === 404) return new Error(DEAD_LINK);
		if (e.status === 429) return new Error("Too many requests. Try again in a minute.");
		if (e.message) return new Error(e.message);
	}
	return new Error(fallback);
}

export async function previewJoin(code: string): Promise<JoinPreview> {
	try {
		return await owRequest<JoinPreview>("POST", "/join/preview", { body: { code } });
	} catch (e) {
		throw words(e, "The invite could not be read. Try again.");
	}
}

/** Accept a person code into the signed-in account. Already a member: say so, and go on. */
export async function acceptJoin(token: string, code: string): Promise<JoinedMembership> {
	try {
		const m = await owRequest<{ world_id: string; world_name: string; role: string }>("POST", "/account/join", {
			token,
			body: { code },
		});
		return { world_id: m.world_id, world_name: m.world_name, role: m.role, already: false };
	} catch (e) {
		if (e instanceof V2ApiError && e.code === "already_member") {
			return { world_id: "", world_name: "", role: "", already: true };
		}
		throw words(e, "Joining did not work. Try again.");
	}
}

/** Redeem a player code with no account: a read key, shown once. */
export async function redeemPlayer(code: string): Promise<PlayerSeat> {
	let a: { kind?: string; key?: string; world?: { id: string; name: string }; character?: { id: string; name: string } | null };
	try {
		a = await owRequest("POST", "/join", { body: { code } });
	} catch (e) {
		if (e instanceof V2ApiError) throw words(e, "Joining did not work. Try again.");
		// No answer: the request may have reached keel and spent the code.
		throw new Error("The answer did not reach this vault. Try once more; if the link says it was used, ask for a new one: each link works once.");
	}
	if (a?.kind !== "player" || !a.key || !a.world) {
		throw new Error("This link did not open as a player's. Ask for a new one.");
	}
	return { key: a.key, world: a.world, character: a.character ?? null };
}
