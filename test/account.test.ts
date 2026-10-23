/**
 * Signing in with an OnlyWorlds account token (OW Infra #358): the token check,
 * the account's worlds, a key minted per vault, the join link, and Create World
 * online on the account route. Every call goes through the mock's requestUrl
 * (test/support/obsidian-mock.ts), answered by `keel` below, whose routes and
 * shapes are the ones keel's OpenAPI document declares (accounts/api.py,
 * accounts/join_api.py). Nothing here reaches the network.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, setRequestUrl, __requests, __notices, __modals, type MockRequest, type MockResponse } from "./support/obsidian-mock";
import { FakeEl } from "./support/fake-dom";
import {
	checkAccountToken,
	owTiming,
	listAccountWorlds,
	mintVaultKey,
	signIn,
	signOut,
	signedInLabel,
	vaultKeyName,
	CREATE_SIGN_IN_FIRST,
	plainHeaders,
	requestUrlFetch,
	type AccountWorld,
} from "../account/account-api";
import { inviteWords, joinCode, previewJoin } from "../account/join";
import { renderAccountWorlds } from "../Modals/AccountWorldList";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { JoinWorldCommand } from "../Commands/JoinWorldCommand";
import { CreateWorldCommand } from "../Commands/CreateWorldCommand";
import { DEFAULT_SETTINGS, type OnlyWorldsPluginSettings } from "../settings/settings";
import type OnlyWorldsPlugin from "../main";

const V2 = "https://www.onlyworlds.com/api/v2";
const TOKEN = "ow_a_testtoken";
const OWNED = "019a0000-0000-7000-8000-0000000000a1";
const SHARED = "019a0000-0000-7000-8000-0000000000b2";
const PLAYED = "019a0000-0000-7000-8000-0000000000c3";
const CHAR = "019a0000-0000-7000-8000-0000000000d4";

const WORLDS: AccountWorld[] = [
	{ id: OWNED, name: "Hyperion", role: "owner", public_read: false, keys: [] },
	{ id: SHARED, name: "Sikelia", role: "collaborator", member_role: "co_builder", public_read: false, keys: [] },
	{ id: PLAYED, name: "Strahd", role: "collaborator", member_role: "guest", public_read: false, keys: [] },
];

interface Keel {
	/** Answers by "METHOD /path" (the path after /api/v2, no query); falls back to `route`. */
	answers: Record<string, MockResponse>;
	route?: (r: MockRequest, path: string) => MockResponse | undefined;
}

function pathOf(url: string): string {
	return new URL(url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
}

/** The world a key opens, for GET /world and /changes. */
function worldFor(key: string): { id: string; name: string } {
	if (key.includes("hyperion")) return { id: OWNED, name: "Hyperion" };
	if (key.includes("sikelia")) return { id: SHARED, name: "Sikelia" };
	if (key.includes("strahd")) return { id: PLAYED, name: "Strahd" };
	if (key.includes("fresh")) return { id: OWNED, name: "Fresh" };
	return { id: OWNED, name: "Hyperion" };
}

function keel(k: Keel): void {
	setRequestUrl((r) => {
		if (!r.url.startsWith(V2)) {
			const hit = k.answers[`${r.method} ${r.url}`];
			if (hit) return hit;
			return { status: 599, json: { error: { message: `unstubbed ${r.method} ${r.url}` } } };
		}
		const path = pathOf(r.url);
		const hit = k.answers[`${r.method} ${path}`] ?? k.route?.(r, path);
		if (hit) return hit;
		if (r.method === "GET" && path === "/world") {
			const w = worldFor(r.headers["API-Key"] ?? "");
			return { status: 200, json: { id: w.id, name: w.name, description: "", time_range_current: 0 } };
		}
		if (r.method === "GET" && path === "/changes") {
			const w = worldFor(r.headers["API-Key"] ?? "");
			return {
				status: 200,
				json: {
					cursor: "c1",
					has_more: false,
					head: 1,
					changes: [
						{ op: "upsert", type: "character", id: CHAR, change_seq: 1, updated_at: "2026-10-16T00:00:00Z", element: { id: CHAR, name: `Hero of ${w.name}` } },
					],
				},
			};
		}
		const mint = path.match(/^\/account\/worlds\/([^/]+)\/keys$/);
		if (r.method === "POST" && mint) {
			const body = JSON.parse(r.body ?? "{}");
			const w = WORLDS.find((x) => x.id === mint[1]) ?? { name: "fresh" };
			const scope = body.scope === "read" ? "read" : "write";
			const key = `ow_${scope === "read" ? "r" : "w"}_minted_${w.name.toLowerCase()}`;
			return { status: 201, json: { id: "k1", name: body.name, last4: key.slice(-4), scope: scope.toUpperCase(), revoked: false, key } };
		}
		return { status: 599, json: { error: { message: `unstubbed ${r.method} ${path}` } } };
	});
}

const accountAnswers = (): Record<string, MockResponse> => ({
	"GET /account": { status: 200, json: { id: "u1", username: "tess", email: "t@example.com", date_joined: null } },
	"GET /account/worlds": { status: 200, json: { data: WORLDS } },
});

function fakePlugin(app: unknown, signedIn: boolean): OnlyWorldsPlugin {
	const settings: OnlyWorldsPluginSettings = {
		...DEFAULT_SETTINGS,
		syncCursors: {},
		accountToken: signedIn ? TOKEN : "",
		accountUsername: signedIn ? "tess" : "",
	};
	return {
		app,
		settings,
		saveSettings: async () => {},
		autoSync: null,
		pinCache: { get: async () => { throw new Error("the PIN was asked"); }, clear: () => {} },
	} as unknown as OnlyWorldsPlugin;
}

function worldMd(vault: { contentAt(p: string): string | undefined }, name: string): string {
	return vault.contentAt(`OnlyWorlds/Worlds/${name}/World.md`) ?? "";
}

/** Headers of every request whose path starts with `prefix`. */
function sent(prefix: string): MockRequest[] {
	return __requests.filter((r) => r.url.startsWith(V2) && pathOf(r.url).startsWith(prefix));
}

// --- 1. the token check and the signed-in label -----------------------------

test("the token check: GET /account with the token as a Bearer, the username back", async () => {
	keel({ answers: accountAnswers() });
	const me = await checkAccountToken(`  ${TOKEN} `);
	assert.equal(me.username, "tess");
	assert.equal(__requests.length, 1);
	assert.equal(__requests[0].method, "GET");
	assert.equal(__requests[0].url, `${V2}/account`);
	assert.equal(__requests[0].headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(__requests[0].headers["API-Key"], undefined);
	assert.equal(signedInLabel(me.username), "Signed in as tess");
});

test("owRequest honours Retry-After on a 429 or 503 once, capped at 10 s (Kael nit)", async () => {
	const waits: number[] = [];
	owTiming.sleep = async (ms: number) => {
		waits.push(ms);
	};
	try {
		for (const [status, after, expectWait] of [[429, "2", 2000], [503, "60", 10000]] as const) {
			let calls = 0;
			waits.length = 0;
			keel({
				answers: {},
				route: (_r, path) => {
					if (path !== "/account") return undefined;
					calls++;
					return calls === 1
						? { status, headers: { "retry-after": after }, json: { error: { message: "slow down" } } }
						: { status: 200, json: { username: "tess" } };
				},
			});
			assert.deepEqual(await checkAccountToken(TOKEN), { username: "tess" });
			assert.equal(calls, 2, `${status}: retried once`);
			assert.deepEqual(waits, [expectWait]);
		}
		// Once only: a second 429 is the answer.
		let calls = 0;
		keel({ answers: {}, route: (_r, path) => (path === "/account" ? (calls++, { status: 429, headers: { "retry-after": "1" }, json: {} }) : undefined) });
		await assert.rejects(checkAccountToken(TOKEN), /Too many requests/);
		assert.equal(calls, 2);
	} finally {
		owTiming.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	}
});

test("the token check refuses a key that is not an account token, without a call", async () => {
	keel({ answers: accountAnswers() });
	await assert.rejects(checkAccountToken("ow_w_aworldkey"), /ow_a_/);
	assert.equal(__requests.length, 0);
});

test("a token keel refuses (401) says so in words", async () => {
	keel({ answers: { "GET /account": { status: 401, json: { error: { code: "invalid_credentials", message: "bad" } } } } });
	await assert.rejects(checkAccountToken(TOKEN), /token/i);
});

test("sign in keeps the token and the username; sign out clears both", async () => {
	keel({ answers: accountAnswers() });
	const { app } = makeApp();
	const plugin = fakePlugin(app, false);
	await signIn(plugin, TOKEN);
	assert.equal(plugin.settings.accountToken, TOKEN);
	assert.equal(plugin.settings.accountUsername, "tess");
	await signOut(plugin);
	assert.equal(plugin.settings.accountToken, "");
	assert.equal(plugin.settings.accountUsername, "");
});

test("sign out revokes the token on onlyworlds.com, found by its last four, with itself as the Bearer (Kael 3.3)", async () => {
	keel({
		answers: {
			...accountAnswers(),
			"GET /account/tokens": { status: 200, json: { data: [
				{ id: "t-other", name: "phone", last4: "abcd", revoked: false },
				{ id: "t-mine", name: "obsidian", last4: TOKEN.slice(-4), revoked: false },
			] } },
			"DELETE /account/tokens/t-mine": { status: 204 },
		},
	});
	const { app } = makeApp();
	const plugin = fakePlugin(app, true);
	const out = await signOut(plugin);
	assert.equal(out.revoked, true);
	assert.equal(plugin.settings.accountToken, "");
	const del = __requests.filter((r) => r.method === "DELETE");
	assert.deepEqual(del.map((r) => pathOf(r.url)), ["/account/tokens/t-mine"]);
	assert.equal(del[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test("sign out whose revoke fails still forgets the token, and says to revoke it on onlyworlds.com (Kael 3.3)", async () => {
	keel({ answers: { "GET /account/tokens": { status: 503, json: { error: { message: "down" } } } } });
	const { app } = makeApp();
	const plugin = fakePlugin(app, true);
	const out = await signOut(plugin);
	assert.equal(out.revoked, false);
	assert.equal(plugin.settings.accountToken, "");
	assert.match(out.message, /revoke it on onlyworlds\.com/);
});

// --- 2. the account's worlds, owned and member -------------------------------

test("the world list: owned and member worlds rendered from keel's answer, and a pick", async () => {
	keel({ answers: accountAnswers() });
	const worlds = await listAccountWorlds(TOKEN);
	assert.equal(sent("/account/worlds")[0].headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(worlds.map((w) => w.name), ["Hyperion", "Sikelia", "Strahd"]);
	const el = new FakeEl();
	let picked: AccountWorld | null = null;
	renderAccountWorlds(el as unknown as HTMLElement, worlds, (w) => { picked = w; });
	const text = el.allText();
	assert.match(text, /Hyperion/);
	assert.match(text, /Owner/);
	assert.match(text, /Sikelia/);
	assert.match(text, /Co-builder/);
	assert.match(text, /Strahd/);
	assert.match(text, /Player/);
	const buttons = el.all().filter((c) => c.tag === "button");
	assert.equal(buttons.length, 3);
	buttons[1].click();
	assert.equal((picked as AccountWorld | null)?.id, SHARED);
});

test("an account with no worlds says so", () => {
	const el = new FakeEl();
	renderAccountWorlds(el as unknown as HTMLElement, [], () => {});
	assert.match(el.allText(), /no worlds/i);
});

// --- 2b. minting a key named for the vault -----------------------------------

test("a key named for the vault: write for an owner", async () => {
	keel({ answers: accountAnswers() });
	assert.equal(vaultKeyName("My Vault"), "obsidian: My Vault");
	const k = await mintVaultKey(TOKEN, WORLDS[0], "My Vault");
	const r = sent(`/account/worlds/${OWNED}/keys`)[0];
	assert.equal(r.method, "POST");
	assert.equal(r.headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(JSON.parse(r.body ?? "{}"), { scope: "write", name: "obsidian: My Vault" });
	assert.equal(k.scope, "write");
	assert.equal(k.key, "ow_w_minted_hyperion");
});

test("a co-builder gets a write key on the member's own route; a player a read key", async () => {
	keel({ answers: accountAnswers() });
	const co = await mintVaultKey(TOKEN, WORLDS[1], "V");
	assert.deepEqual(JSON.parse(sent(`/account/worlds/${SHARED}/keys`)[0].body ?? "{}"), { scope: "write", name: "obsidian: V" });
	assert.equal(co.scope, "write");
	const guest = await mintVaultKey(TOKEN, WORLDS[2], "V");
	assert.deepEqual(JSON.parse(sent(`/account/worlds/${PLAYED}/keys`)[0].body ?? "{}"), { scope: "read", name: "obsidian: V" });
	assert.equal(guest.scope, "read");
});

test("a member whose account has no PIN yet (409 pin_required) gets a read key, and is told", async () => {
	let calls = 0;
	keel({
		answers: accountAnswers(),
		route: (r, path) => {
			if (r.method === "POST" && path === `/account/worlds/${SHARED}/keys` && JSON.parse(r.body ?? "{}").scope === "write") {
				calls++;
				return { status: 409, json: { error: { code: "pin_required", message: "pin" } } };
			}
			return undefined;
		},
	});
	const k = await mintVaultKey(TOKEN, WORLDS[1], "V");
	assert.equal(calls, 1);
	assert.equal(k.scope, "read");
	assert.equal(k.readForWantOfPin, true);
});

// --- 2c. Download World from the account --------------------------------------

test("a key minted for a download that then fails is revoked, so no live key is left that no vault holds (Kael nit)", async () => {
	keel({
		answers: {
			...accountAnswers(),
			"GET /world": { status: 500, json: { error: { message: "boom" } } },
			[`DELETE /account/worlds/${OWNED}/keys/k1`]: { status: 204 },
		},
	});
	const { app, vault } = makeApp();
	const cmd = new DownloadWorldCommand(app, { version: "test" }, fakePlugin(app, true));
	assert.equal(await cmd.downloadAccountWorld(WORLDS[0]), null);
	assert.equal(sent(`/account/worlds/${OWNED}/keys`).filter((r) => r.method === "POST").length, 1);
	const deletes = __requests.filter((r) => r.method === "DELETE").map((r) => pathOf(r.url));
	assert.deepEqual(deletes, [`/account/worlds/${OWNED}/keys/k1`]);
	assert.equal(vault.getAbstractFileByPath("OnlyWorlds/Worlds/Hyperion"), null);
});

test("download from the account: mint for the vault, download with it, the key lands in World.md, no PIN", async () => {
	keel({ answers: accountAnswers() });
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, true);
	const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
	const folder = await cmd.downloadAccountWorld(WORLDS[0]);
	assert.equal(folder, "Hyperion");
	assert.match(worldMd(vault, "Hyperion"), /- \*\*API Key:\*\* ow_w_minted_hyperion/);
	const mint = sent(`/account/worlds/${OWNED}/keys`);
	assert.equal(JSON.parse(mint[0].body ?? "{}").name, "obsidian: Test Vault");
	for (const r of [...sent("/world"), ...sent("/changes")]) {
		assert.equal(r.headers["API-Key"], "ow_w_minted_hyperion");
		assert.equal(r.headers["API-Pin"] ?? "", "", "a read never carries a PIN");
		assert.equal(r.headers.Authorization, undefined);
	}
	assert.ok(vault.getMarkdownFiles().some((f) => f.path.includes("Hero of Hyperion")));
});

// A held WRITE key is reused; a held READ key is upgraded when the role can
// write (the next test), and kept when keel still wants a PIN (the one after).
test("downloading the same account world again reuses the vault's write key, no second mint", async () => {
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, true);
	const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
	keel({ answers: accountAnswers() });
	await cmd.downloadAccountWorld(WORLDS[0]);
	const listed: AccountWorld = { ...WORLDS[0], keys: [{ name: "obsidian: Test Vault", last4: "rion", scope: "WRITE", revoked: false }] };
	keel({ answers: { ...accountAnswers(), "GET /account/worlds": { status: 200, json: { data: [listed] } } } });
	const again = await cmd.downloadAccountWorld(listed);
	assert.equal(again, "Hyperion", __notices.join(" / "));
	assert.equal(sent(`/account/worlds/${OWNED}/keys`).length, 0, "a second key was minted");
	assert.equal(vault.getAbstractFileByPath("OnlyWorlds/Worlds/Hyperion (1)"), null);
});

test("downloading again holding only a READ key, as a role that can write: a write key is minted, replaces it in World.md, and the read key is revoked (Kael 3.2)", async () => {
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, true);
	const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
	keel({ answers: accountAnswers() });
	assert.equal(await cmd.downloadWithKey("ow_r_hyperion_rk01", ""), "Hyperion"); // read for want of a PIN, earlier
	const listedKeys = { data: [{ id: "kr1", last4: "rk01", scope: "READ", revoked: false }, { id: "k1", last4: "rion", scope: "WRITE", revoked: false }] };
	keel({
		answers: {
			...accountAnswers(),
			[`GET /account/worlds/${OWNED}/keys`]: { status: 200, json: listedKeys },
			[`DELETE /account/worlds/${OWNED}/keys/kr1`]: { status: 204 },
		},
	});
	const again = await cmd.downloadAccountWorld(WORLDS[0]); // the owner: can write
	assert.equal(again, "Hyperion", __notices.join(" / "));
	const mints = sent(`/account/worlds/${OWNED}/keys`).filter((r) => r.method === "POST");
	assert.equal(mints.length, 1);
	assert.equal(JSON.parse(mints[0].body ?? "{}").scope, "write");
	assert.match(worldMd(vault, "Hyperion"), /- \*\*API Key:\*\* ow_w_minted_hyperion/);
	const deletes = __requests.filter((r) => r.method === "DELETE").map((r) => pathOf(r.url));
	assert.deepEqual(deletes, [`/account/worlds/${OWNED}/keys/kr1`]);
	assert.equal(vault.getAbstractFileByPath("OnlyWorlds/Worlds/Hyperion (1)"), null);
});

test("a held read key, still no account PIN: no new key, the read key stays, and the user is told (Kael 3.2)", async () => {
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, true);
	const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
	keel({ answers: accountAnswers() });
	await cmd.downloadWithKey("ow_r_sikelia_rk02", "");
	keel({
		answers: accountAnswers(),
		route: (r, path) =>
			r.method === "POST" && path === `/account/worlds/${SHARED}/keys`
				? { status: 409, json: { error: { code: "pin_required", message: "pin" } } }
				: undefined,
	});
	__notices.length = 0;
	assert.equal(await cmd.downloadAccountWorld(WORLDS[1]), "Sikelia");
	const posts = sent(`/account/worlds/${SHARED}/keys`).filter((r) => r.method === "POST");
	assert.deepEqual(posts.map((r) => JSON.parse(r.body ?? "{}").scope), ["write"], "a read key was minted on top");
	assert.match(worldMd(vault, "Sikelia"), /- \*\*API Key:\*\* ow_r_sikelia_rk02/);
	assert.ok(__notices.some((n) => /no PIN yet/.test(n)));
});

test("a world already in the vault under a legacy key, or a key the account does not list, is found by its id: no mint, no 'Name (1)' (Kael 3.4)", async () => {
	for (const held of ["1234567890", "ow_w_unlisted_hyperion"]) {
		const { app, vault } = makeApp();
		const plugin = fakePlugin(app, true);
		const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
		keel({ answers: accountAnswers() });
		assert.equal(await cmd.downloadWithKey(held, ""), "Hyperion");
		keel({ answers: accountAnswers() });
		const again = await cmd.downloadAccountWorld(WORLDS[0]); // keys: [] — the account lists none of this vault's
		assert.equal(again, "Hyperion", `${held}: ${__notices.join(" / ")}`);
		assert.equal(sent(`/account/worlds/${OWNED}/keys`).length, 0, `${held}: a key was minted`);
		assert.equal(vault.getAbstractFileByPath("OnlyWorlds/Worlds/Hyperion (1)"), null, `${held}: came down twice`);
		assert.match(worldMd(vault, "Hyperion"), new RegExp(`- \\*\\*API Key:\\*\\* ${held}`));
	}
});

// --- 3. the join link ----------------------------------------------------------

const PREVIEW = (reader: string, role: string) => ({
	status: 200,
	json: { reader, world: { name: reader === "player" ? "Strahd" : "Sikelia", description: "" }, invited_by: "Ana", owner_character: null, role, with_character: false, expires_at: "2026-11-01T00:00:00Z" },
});

test("the join code comes out of a link, a message, or stands bare", () => {
	assert.equal(joinCode("https://www.onlyworlds.com/join#ow_j_Abc-12_x"), "ow_j_Abc-12_x");
	assert.equal(joinCode("  ow_j_Abc  "), "ow_j_Abc");
	assert.equal(joinCode("come play: https://www.onlyworlds.com/join#ow_j_Q9 see you"), "ow_j_Q9");
	assert.equal(joinCode("https://www.onlyworlds.com/join"), null);
});

test("the preview sends the code with no credential, and says who invites and as what", async () => {
	keel({ answers: { "POST /join/preview": PREVIEW("person", "co_builder") } });
	const p = await previewJoin("ow_j_X");
	const r = __requests[0];
	assert.equal(r.url, `${V2}/join/preview`);
	assert.equal(r.method, "POST");
	assert.deepEqual(JSON.parse(r.body ?? "{}"), { code: "ow_j_X" });
	assert.equal(r.headers.Authorization, undefined);
	assert.equal(r.headers["API-Key"], undefined);
	assert.equal(inviteWords(p), "Ana invites you to Sikelia as a co-builder.");
});

test("a dead code's preview (404) says the link does not work", async () => {
	keel({ answers: { "POST /join/preview": { status: 404, json: { error: { code: "not_found", message: "x" } } } } });
	await assert.rejects(previewJoin("ow_j_dead"), /does not work/);
});

test("a person code: preview, accept into the signed-in account, then download as from the account", async () => {
	keel({
		answers: {
			...accountAnswers(),
			"POST /join/preview": PREVIEW("person", "co_builder"),
			"POST /account/join": { status: 201, json: { id: "m1", world_id: SHARED, world_name: "Sikelia", role: "co_builder", joined_at: "2026-10-16T00:00:00Z", roster_character: null } },
		},
	});
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, true);
	const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
	let asked = "";
	await join.joinWith("https://www.onlyworlds.com/join#ow_j_person", async (words) => { asked = words; return true; });
	assert.equal(asked, "Ana invites you to Sikelia as a co-builder.");
	const accept = sent("/account/join")[0];
	assert.equal(accept.method, "POST");
	assert.equal(accept.headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(JSON.parse(accept.body ?? "{}"), { code: "ow_j_person" });
	assert.equal(JSON.parse(sent(`/account/worlds/${SHARED}/keys`)[0].body ?? "{}").scope, "write");
	assert.match(worldMd(vault, "Sikelia"), /- \*\*API Key:\*\* ow_w_minted_sikelia/);
});

test("a person code, declined at the preview, accepts nothing", async () => {
	keel({ answers: { ...accountAnswers(), "POST /join/preview": PREVIEW("person", "contributor") } });
	const { app } = makeApp();
	const plugin = fakePlugin(app, true);
	const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
	await join.joinWith("ow_j_person", async () => false);
	assert.equal(sent("/account/join").length, 0);
});

test("a person code's preview says the key by role: a guest's is a read key, a role that writes keeps the plain line (Seethe's walk, h37 #6503)", async () => {
	const READ_LINE = "This vault then downloads the world with its own read key: you can read it here, not change it.";
	const WRITE_LINE = "This vault then downloads the world with its own key.";
	for (const [role, line] of [["guest", READ_LINE], ["co_builder", WRITE_LINE], ["contributor", WRITE_LINE]] as const) {
		keel({ answers: { ...accountAnswers(), "POST /join/preview": PREVIEW("person", role) } });
		const { app } = makeApp();
		const plugin = fakePlugin(app, true);
		const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
		let detail = "";
		await join.joinWith("ow_j_person", async (_w, d) => { detail = d; return false; });
		assert.equal(detail, `You join as tess. ${line}`, role);
		assert.equal(sent("/account/join").length, 0, role);
	}
});

test("a person code with no account signed in asks to sign in first, and accepts nothing", async () => {
	keel({ answers: { "POST /join/preview": PREVIEW("person", "co_builder") } });
	const { app } = makeApp();
	const plugin = fakePlugin(app, false);
	const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
	__notices.length = 0;
	await join.joinWith("ow_j_person", async () => true);
	assert.equal(sent("/account/join").length, 0);
	assert.ok(__notices.some((n) => /sign in/i.test(n)), __notices.join(" / "));
});

test("a player code redeems with no account and downloads read-only with the key it returns", async () => {
	keel({
		answers: {
			"POST /join/preview": PREVIEW("player", "guest"),
			"POST /join": {
				status: 201,
				json: { kind: "player", key: "ow_r_player_strahd", world: { id: PLAYED, name: "Strahd", description: "" }, character: { id: CHAR, name: "Ireena" }, role: "guest" },
			},
		},
	});
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, false);
	const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
	let asked = "";
	await join.joinWith("ow_j_player", async (w) => { asked = w; return true; });
	assert.equal(asked, "Ana invites you to Strahd as a player.");
	const redeem = sent("/join").filter((r) => pathOf(r.url) === "/join")[0];
	assert.equal(redeem.method, "POST");
	assert.deepEqual(JSON.parse(redeem.body ?? "{}"), { code: "ow_j_player" });
	assert.equal(redeem.headers.Authorization, undefined);
	assert.equal(redeem.headers["API-Key"], undefined);
	assert.equal(sent("/account").length, 0, "a player code touched the account routes");
	for (const r of sent("/world")) {
		assert.equal(r.headers["API-Key"], "ow_r_player_strahd");
		assert.equal(r.headers["API-Pin"] ?? "", "");
	}
	assert.match(worldMd(vault, "Strahd"), /- \*\*API Key:\*\* ow_r_player_strahd/);
});

test("an agent code is refused with words: it is for an AI, not a vault", async () => {
	keel({ answers: { "POST /join/preview": PREVIEW("agent", "contributor") } });
	const { app } = makeApp();
	const plugin = fakePlugin(app, true);
	const join = new JoinWorldCommand(app, plugin, new DownloadWorldCommand(app, { version: "test" }, plugin));
	__notices.length = 0;
	let asked = false;
	await join.joinWith("ow_j_agent", async () => { asked = true; return true; });
	assert.equal(asked, false);
	assert.equal(__requests.length, 1, "only the preview was sent");
	assert.ok(__notices.some((n) => /AI agent/.test(n) && /not .*vault/i.test(n)), __notices.join(" / "));
});

// --- 4. Create World online ----------------------------------------------------
// Through the SDK's createAccountWorld on POST /api/v2/account/worlds only (OW
// Obsidian #577): keel #134 froze the old email-and-PIN route, which the plugin
// no longer names anywhere.

const OLD_ROUTE = "/api/worldsync/";

function noOldRoute(): void {
	assert.ok(!__requests.some((r) => r.url.includes(OLD_ROUTE)), "the old create route was called");
}

/** POST /account/worlds as keel answers it: the world's row and its one key, shown once, named as asked. */
function createAnswer(r: MockRequest, key: string | null = "ow_w_created_by_create"): MockResponse {
	const b = JSON.parse(r.body ?? "{}");
	return {
		status: 201,
		json: { id: OWNED, name: b.name, role: "owner", public_read: false, keys: [{ name: b.key_name ?? "", last4: "eate", scope: "WRITE", revoked: false }], ...(key ? { key } : {}) },
	};
}

test("★ Create World online, signed in: the account's create route through the SDK, the world's one key named for the vault as Download World names it; nothing minted, nothing revoked, never the old route (#577)", async () => {
	keel({
		answers: accountAnswers(),
		route: (r, path) => (r.method === "POST" && path === "/account/worlds" ? createAnswer(r) : undefined),
	});
	const { app } = makeApp();
	__modals.length = 0;
	const plugin = fakePlugin(app, true);
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: plugin.settings.accountToken, username: plugin.settings.accountUsername }));
	const res = await cmd.createWorldOnServer({ name: "Fresh", pin: 1234 });
	const create = __requests.filter((r) => r.method === "POST" && r.url === `${V2}/account/worlds`);
	assert.equal(create.length, 1);
	assert.equal(create[0].headers.Authorization, `Bearer ${TOKEN}`);
	assert.deepEqual(JSON.parse(create[0].body ?? "{}"), { name: "Fresh", key_name: vaultKeyName("Test Vault") }, "the PIN went where keel did not ask for it, or the key went unnamed");
	assert.equal(res?.api_key, "ow_w_created_by_create");
	assert.equal(res?.afterLanding, undefined);
	assert.equal(sent(`/account/worlds/${OWNED}/keys`).length, 0, "a second key was minted or listed");
	assert.equal(__requests.filter((r) => r.method === "DELETE").length, 0);
	assert.equal(__modals.length, 0, "the shown-once key was shown in a modal");
	noOldRoute();
});

test("★ Create World, signed in, the whole command: the shown-once key goes into World.md and is shown nowhere else (#577)", async () => {
	keel({
		answers: accountAnswers(),
		route: (r, path) => (r.method === "POST" && path === "/account/worlds" ? createAnswer(r) : undefined),
	});
	const { app, vault } = makeApp();
	__modals.length = 0;
	__notices.length = 0;
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: TOKEN, username: "tess" }), () => false);
	const running = cmd.execute();
	for (let i = 0; i < 20 && __modals.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
	const modal = __modals[0] as unknown as { onSubmit: (d: { name: string; pin: number }) => void };
	modal.onSubmit({ name: "Fresh", pin: 1234 });
	await running;
	assert.match(worldMd(vault, "Fresh"), /- \*\*API Key:\*\* ow_w_created_by_create/);
	assert.equal(__modals.length, 1, "a modal opened after the create's own");
	assert.ok(!__notices.some((n) => JSON.stringify(n).includes("ow_w_created_by_create")), "a notice showed the key");
	noOldRoute();
});

test("★ Create World online, not signed in: nothing is sent anywhere, and the person is asked to sign in (#577)", async () => {
	keel({ answers: {} });
	const { app } = makeApp();
	__modals.length = 0;
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => null);
	const res = await cmd.createWorldOnServer({ name: "Old", pin: 1234 });
	assert.equal(res, null);
	assert.equal(__requests.length, 0, "a request went out with no account");
	const said = __modals[0] as unknown as { message: string; success: boolean };
	assert.equal(said.success, false);
	assert.equal(said.message, CREATE_SIGN_IN_FIRST);
	assert.match(CREATE_SIGN_IN_FIRST, /sign in first/);
});

test("★ the plugin's bundle names the old create route nowhere (#577)", () => {
	const code = readFileSync(join(__dirname, "..", "main.js"), "utf8");
	assert.ok(!code.includes("create-world-external"), "the bundle still carries the old create route");
	assert.ok(!code.includes(OLD_ROUTE), "the bundle still calls a worldsync route");
});

test("Create World online, signed in: a typed PIN is checked against the account before anything is created (Kael nit)", async () => {
	for (const [pin, created] of [[9999, 0], [1234, 1]] as const) {
		keel({
			answers: {
				...accountAnswers(),
				"POST /account/worlds": { status: 201, json: { id: OWNED, name: "Fresh", role: "owner", public_read: false, keys: [], key: "ow_w_created_by_create" } },
			},
			route: (r, path) =>
				path === "/world" && r.headers["API-Pin"] && r.headers["API-Pin"] !== "1234"
					? { status: 401, json: { error: { code: "invalid_credentials", message: "Incorrect PIN.", param: "API-Pin" } } }
					: undefined,
		});
		const { app, vault } = makeApp();
		// This vault already holds a world the account owns (Hyperion): its key
		// can test the PIN on a read.
		await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **API Key:** ow_w_hyperion_held\n");
		const plugin = fakePlugin(app, true);
		const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: plugin.settings.accountToken, username: plugin.settings.accountUsername }));
		const res = await cmd.createWorldOnServer({ name: "Fresh", pin });
		const posts = sent("/account/worlds").filter((r) => pathOf(r.url) === "/account/worlds" && r.method === "POST");
		assert.equal(posts.length, created, `PIN ${pin}`);
		assert.equal(res === null, created === 0, `PIN ${pin}`);
		noOldRoute();
	}
});

test("Create World online, signed in, a create answer without a full write key: mint the vault's key, then revoke the create key", async () => {
	keel({
		answers: {
			...accountAnswers(),
			[`GET /account/worlds/${OWNED}/keys`]: {
				status: 200,
				json: { data: [
					{ id: "k0", name: "obsidian: Test Vault", last4: "eate", scope: "WRITE", revoked: false },
					{ id: "k1", name: "obsidian: Test Vault", last4: "rion", scope: "WRITE", revoked: false },
				] },
			},
			[`DELETE /account/worlds/${OWNED}/keys/k0`]: { status: 204 },
		},
		route: (r, path) => (r.method === "POST" && path === "/account/worlds" ? createAnswer(r, null) : undefined),
	});
	const { app } = makeApp();
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: TOKEN, username: "tess" }));
	const res = await cmd.createWorldOnServer({ name: "Fresh", pin: 1234 });
	assert.equal(res?.api_key, "ow_w_minted_hyperion");
	assert.equal(__requests.filter((r) => r.method === "DELETE").length, 0, "the create key went before the vault key landed");
	await res?.afterLanding?.();
	const mint = sent(`/account/worlds/${OWNED}/keys`).filter((r) => r.method === "POST");
	assert.equal(JSON.parse(mint[0].body ?? "{}").name, "obsidian: Test Vault");
	const revoked = __requests.filter((r) => r.method === "DELETE");
	assert.equal(revoked.length, 1);
	assert.equal(pathOf(revoked[0].url), `/account/worlds/${OWNED}/keys/k0`);
	assert.equal(revoked[0].headers.Authorization, `Bearer ${TOKEN}`);
	noOldRoute();
});

test("Create World online, signed in, no full key in the answer and no key for the vault could be made: the person is told, nothing half-linked", async () => {
	keel({
		answers: {
			...accountAnswers(),
			[`POST /account/worlds/${OWNED}/keys`]: { status: 500, json: { error: { code: "server_error", message: "boom" } } },
		},
		route: (r, path) => (r.method === "POST" && path === "/account/worlds" ? createAnswer(r, null) : undefined),
	});
	const { app } = makeApp();
	__modals.length = 0;
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: TOKEN, username: "tess" }));
	const res = await cmd.createWorldOnServer({ name: "Fresh", pin: 1234 });
	assert.equal(res, null);
	assert.equal(__modals.length, 1);
	assert.match((__modals[0] as unknown as { message: string }).message, /no key for this vault could be made/);
	assert.equal(__requests.filter((r) => r.method === "DELETE").length, 0);
});

test("Create World online, signed in, an account with no PIN yet: keel asks (422 param pin), the PIN goes once, the key still named", async () => {
	keel({
		answers: accountAnswers(),
		route: (r, path) => {
			if (r.method === "POST" && path === "/account/worlds") {
				const b = JSON.parse(r.body ?? "{}");
				if (b.pin === undefined) return { status: 422, json: { error: { code: "invalid_request", param: "pin", message: "Your account has no PIN yet." } } };
				return createAnswer(r, "ow_w_created");
			}
			return undefined;
		},
	});
	const { app } = makeApp();
	const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => ({ token: TOKEN, username: "tess" }));
	const res = await cmd.createWorldOnServer({ name: "Fresh", pin: 4321 });
	const creates = __requests.filter((r) => r.url === `${V2}/account/worlds` && r.method === "POST");
	assert.equal(creates.length, 2);
	assert.deepEqual(JSON.parse(creates[0].body ?? "{}"), { name: "Fresh", key_name: "obsidian: Test Vault" });
	assert.deepEqual(JSON.parse(creates[1].body ?? "{}"), { name: "Fresh", pin: "4321", key_name: "obsidian: Test Vault" });
	assert.equal(res?.api_key, "ow_w_created");
	noOldRoute();
});

test("requestUrlFetch: headers as a Headers instance, as pairs or as an object all reach requestUrl as a plain object (Amendment A, low)", async () => {
	assert.deepEqual(plainHeaders(new Headers({ Authorization: "Bearer t", "Content-Type": "application/json" })), { authorization: "Bearer t", "content-type": "application/json" });
	assert.deepEqual(plainHeaders([["X-A", "1"]]), { "X-A": "1" });
	assert.deepEqual(plainHeaders({ "X-B": "2" }), { "X-B": "2" });
	assert.deepEqual(plainHeaders(undefined), {});
	setRequestUrl(() => ({ status: 200, json: { ok: true } }));
	__requests.length = 0;
	const res = await requestUrlFetch(`${V2}/health`, { method: "POST", headers: new Headers({ Authorization: "Bearer t" }), body: "{}" });
	assert.equal(res.status, 200);
	assert.equal(__requests[0].headers.authorization, "Bearer t");
	assert.equal(__requests[0].body, "{}");
});

test("requestUrlFetch refuses a body that is not a string, and sends nothing (Amendment A, low)", async () => {
	setRequestUrl(() => ({ status: 200, json: {} }));
	__requests.length = 0;
	await assert.rejects(requestUrlFetch(`${V2}/health`, { method: "POST", body: new Uint8Array([1]) }), /only a string body; this request was not sent/);
	assert.equal(__requests.length, 0);
});

test("the Default email setting is gone; an older data.json that still holds it loads as before (Amendment B)", () => {
	assert.equal("defaultEmail" in DEFAULT_SETTINGS, false);
	// main.ts loadSettings: Object.assign({}, DEFAULT_SETTINGS, data)
	const loaded = Object.assign({}, DEFAULT_SETTINGS, { defaultEmail: "a@b.c", defaultWorld: "Hyperion" });
	assert.equal(loaded.defaultWorld, "Hyperion");
	assert.equal(loaded.defaultCategory, DEFAULT_SETTINGS.defaultCategory);
});

// --- the key-and-PIN download stays as it is ------------------------------------

test("Download World with a pasted key and PIN: the modal's path, unchanged (key and PIN as typed)", async () => {
	keel({ answers: {} });
	const { app, vault } = makeApp();
	const plugin = fakePlugin(app, false);
	__modals.length = 0;
	const cmd = new DownloadWorldCommand(app, { version: "test" }, plugin);
	await cmd.execute();
	const modal = __modals[__modals.length - 1] as unknown as { onSubmit: (d: { apiKey: string; pin: string }) => Promise<void> };
	await modal.onSubmit({ apiKey: " ow_w_pasted_hyperion ", pin: "1234" });
	const reads = [...sent("/world"), ...sent("/changes")];
	assert.ok(reads.length >= 2);
	for (const r of reads) {
		assert.equal(r.headers["API-Key"], "ow_w_pasted_hyperion");
		assert.equal(r.headers["API-Pin"], "1234");
	}
	assert.equal(sent("/account").length, 0);
	assert.match(worldMd(vault, "Hyperion"), /- \*\*API Key:\*\* ow_w_pasted_hyperion/);
});
