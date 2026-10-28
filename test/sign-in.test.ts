/**
 * Sign in and Create account: the two commands, the Sign in dialog, and the
 * Download and Create world dialogs offering it to a signed-out vault. The
 * dialogs are rendered into a FakeEl (test/support/fake-dom.ts) and clicked;
 * every request goes through the mock's requestUrl, and `window.open` is a
 * recorder, so nothing reaches the network or a browser.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { makeApp, setRequestUrl, __requests, __notices, __modals, type MockResponse } from "./support/obsidian-mock";
import { FakeEl } from "./support/fake-dom";
import { NOT_A_TOKEN, CREATE_SIGN_IN_FIRST, TOKEN_STORAGE_NOTE, type AccountWorld } from "../account/account-api";
import { openSignIn, registerAccountCommands } from "../account/sign-in";
import { SignInModal } from "../Modals/SignInModal";
import { WorldDownloadModal } from "../Modals/WorldDownloadModal";
import { CreateWorldModal } from "../Modals/CreateWorldModal";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { CreateWorldCommand } from "../Commands/CreateWorldCommand";
import { DEFAULT_SETTINGS, type OnlyWorldsPluginSettings } from "../settings/settings";
import type OnlyWorldsPlugin from "../main";
import type { PluginManifest } from "obsidian";

const V2 = "https://www.onlyworlds.com/api/v2";
const TOKEN = "ow_a_testtoken";
const ROOT = join(__dirname, "..", "..");

const WORLDS: AccountWorld[] = [{ id: "019a0000-0000-7000-8000-0000000000a1", name: "Hyperion", role: "owner", keys: [] }];

/** keel's two account routes; anything else fails loudly. */
function keel(extra: Record<string, MockResponse> = {}): void {
	const answers: Record<string, MockResponse> = {
		"GET /account": { status: 200, json: { id: "u1", username: "tess" } },
		"GET /account/worlds": { status: 200, json: { data: WORLDS } },
		...extra,
	};
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		return answers[`${r.method} ${path}`] ?? { status: 599, json: { error: { message: `unstubbed ${r.method} ${r.url}` } } };
	});
}

interface Host {
	app: unknown;
	settings: OnlyWorldsPluginSettings;
	saveSettings: () => Promise<void>;
	saves: number;
}

function host(app: unknown, signedIn: boolean): Host {
	const h: Host = {
		app,
		settings: {
			...DEFAULT_SETTINGS,
			syncCursors: {},
			accountToken: signedIn ? TOKEN : "",
			accountUsername: signedIn ? "tess" : "",
		},
		saves: 0,
		saveSettings: async () => {
			h.saves++;
		},
	};
	return h;
}
const asPlugin = (h: Host) => h as unknown as OnlyWorldsPlugin;

/** The browser: every window.open call, recorded. */
const opened: Array<[string, string]> = [];
(globalThis as unknown as { window: unknown }).window = {
	open: (url: string, target: string) => {
		opened.push([url, target]);
		return null;
	},
};

function reset(): void {
	__modals.length = 0;
	__notices.length = 0;
	opened.length = 0;
}

/** Render a modal into a FakeEl, as Obsidian would call onOpen. */
async function render(m: unknown): Promise<FakeEl> {
	const el = new FakeEl();
	const modal = m as { contentEl: unknown; onOpen: () => unknown };
	modal.contentEl = el;
	await modal.onOpen();
	return el;
}
const byText = (el: FakeEl, tag: string, text: string) => el.all().find((c) => c.tag === tag && c.text === text);
const inputs = (el: FakeEl) => el.all().filter((c) => c.tag === "input");
/** Let the click's promise chain (the mock's requestUrl, saveSettings) run out. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
/** Track a modal's close(). */
function closes(m: unknown): { closed: boolean } {
	const seen = { closed: false };
	(m as { close: () => void }).close = () => {
		seen.closed = true;
	};
	return seen;
}

// --- the commands -----------------------------------------------------------

test("the two commands are registered as sign-in (Sign in) and create-account (Create account), from the plugin's onload", () => {
	reset();
	const { app } = makeApp();
	const added: Array<{ id: string; name: string }> = [];
	registerAccountCommands({ ...host(app, false), addCommand: (c: { id: string; name: string }) => added.push(c) } as never);
	assert.deepEqual(
		added.map((c) => [c.id, c.name]),
		[
			["sign-in", "Sign in"],
			["create-account", "Create account"],
		]
	);
	assert.match(readFileSync(join(ROOT, "main.ts"), "utf8"), /registerAccountCommands\(this\)/);
});

test("Sign in, signed in: a notice with the account's name and no dialog", () => {
	reset();
	const { app } = makeApp();
	const commands: Record<string, () => void> = {};
	registerAccountCommands({ ...host(app, true), addCommand: (c: { id: string; callback: () => void }) => (commands[c.id] = c.callback) } as never);
	commands["sign-in"]();
	assert.deepEqual(__notices, ["Signed in as tess. To switch accounts, sign out in Settings first."]);
	assert.equal(__modals.length, 0);
});

test("Sign in, signed out: the Sign in to OnlyWorlds dialog", async () => {
	reset();
	const { app } = makeApp();
	const commands: Record<string, () => void> = {};
	registerAccountCommands({ ...host(app, false), addCommand: (c: { id: string; callback: () => void }) => (commands[c.id] = c.callback) } as never);
	commands["sign-in"]();
	assert.equal(__modals.length, 1);
	assert.ok(__modals[0] instanceof SignInModal);
	const el = await render(__modals[0]);
	assert.ok(byText(el, "h3", "Sign in to OnlyWorlds"));
	assert.match(el.allText(), /Paste an account token\. Make one on onlyworlds\.com, in Account settings under Account tokens\./);
	const field = inputs(el);
	assert.equal(field.length, 1);
	assert.equal(field[0].attrs.type, "password");
	assert.equal(field[0].attrs.placeholder, "ow_a_…");
	const note = el.all().findIndex((c) => c.text === TOKEN_STORAGE_NOTE);
	assert.equal(note, el.all().indexOf(field[0]) + 1, "the token storage note sits under the field");
	assert.ok(byText(el, "button", "Sign in"));
	const seen = closes(__modals[0]);
	byText(el, "button", "Cancel")!.click();
	assert.equal(seen.closed, true, "Cancel closes the dialog");
});

test("Create account opens the sign-up page in the browser and says to come back and sign in", () => {
	reset();
	const { app } = makeApp();
	const commands: Record<string, () => void> = {};
	registerAccountCommands({ ...host(app, false), addCommand: (c: { id: string; callback: () => void }) => (commands[c.id] = c.callback) } as never);
	commands["create-account"]();
	assert.deepEqual(opened, [["https://www.onlyworlds.com/accounts/signup/", "_blank"]]);
	assert.deepEqual(__notices, ["Opened the sign-up page. When you have an account, come back and run Sign in."]);
	assert.equal(__modals.length, 0);
});

// --- the Sign in dialog -----------------------------------------------------

test("the dialog passes the typed token to sign-in: kept with its username, the Settings tab's notice, closed", async () => {
	reset();
	keel();
	const { app } = makeApp();
	const h = host(app, false);
	let after: string | null = null;
	openSignIn(asPlugin(h), { then: (u) => (after = u) });
	const m = __modals[0];
	const seen = closes(m);
	const el = await render(m);
	inputs(el)[0].value = `  ${TOKEN} `;
	byText(el, "button", "Sign in")!.click();
	await flush();
	assert.equal(__requests.length, 1);
	assert.equal(__requests[0].url, `${V2}/account`);
	assert.equal(__requests[0].headers.Authorization, `Bearer ${TOKEN}`);
	assert.equal(h.settings.accountToken, TOKEN);
	assert.equal(h.settings.accountUsername, "tess");
	assert.equal(h.saves, 1);
	assert.deepEqual(__notices, ["Signed in as tess"]);
	assert.equal(seen.closed, true);
	assert.equal(after, "tess");
});

test("the dialog shows NOT_A_TOKEN for a token that does not start ow_a_, sends nothing and stays open", async () => {
	reset();
	keel();
	const { app } = makeApp();
	const h = host(app, false);
	let after = false;
	openSignIn(asPlugin(h), { then: () => (after = true) });
	const m = __modals[0];
	const seen = closes(m);
	const el = await render(m);
	inputs(el)[0].value = "ow_w_aworldkey";
	const button = byText(el, "button", "Sign in")!;
	button.click();
	await flush();
	assert.match(el.allText(), new RegExp(NOT_A_TOKEN.replace(/[.]/g, "\\.")));
	assert.equal(__requests.length, 0);
	assert.equal(h.settings.accountToken, "");
	assert.equal(h.saves, 0);
	assert.equal(seen.closed, false);
	assert.equal(after, false);
	assert.equal(button.disabled, false, "the button can be pressed again");
});

test("Open Account settings and Make a free account open exactly their two addresses, _blank", async () => {
	reset();
	const { app } = makeApp();
	openSignIn(asPlugin(host(app, false)));
	const el = await render(__modals[0]);
	byText(el, "a", "Open Account settings")!.click();
	byText(el, "a", "Make a free account")!.click();
	assert.deepEqual(opened, [
		["https://www.onlyworlds.com/account/settings", "_blank"],
		["https://www.onlyworlds.com/accounts/signup/", "_blank"],
	]);
});

// --- the Download dialog ----------------------------------------------------

const OFFER = "Sign in to pick from your worlds";

test("the Download dialog, signed out, has the sign-in line above the key fields, and it opens the Sign in dialog", async () => {
	reset();
	const { app } = makeApp();
	void new DownloadWorldCommand(app as never, {}, asPlugin(host(app, false))).execute();
	const dl = __modals[0];
	assert.ok(dl instanceof WorldDownloadModal);
	const el = await render(dl);
	const all = el.all();
	const offer = byText(el, "button", OFFER);
	assert.ok(offer, "the sign-in line is shown");
	const keyLabel = all.findIndex((c) => c.tag === "label" && c.text === "API key");
	assert.ok(all.indexOf(offer) < keyLabel, "the line sits above the key fields");
	offer.click();
	assert.equal(__modals.length, 2);
	assert.ok(__modals[1] instanceof SignInModal);
});

test("the Download dialog, signed in, has no sign-in line", async () => {
	reset();
	keel();
	const { app } = makeApp();
	void new DownloadWorldCommand(app as never, {}, asPlugin(host(app, true))).execute();
	const el = await render(__modals[0]);
	await flush();
	assert.equal(byText(el, "button", OFFER), undefined);
	assert.match(el.allText(), /From your account/);
});

test("a sign-in from the Download dialog runs Download again, which lists the account's worlds", async () => {
	reset();
	keel();
	const { app } = makeApp();
	const h = host(app, false);
	void new DownloadWorldCommand(app as never, {}, asPlugin(h)).execute();
	const dl = __modals[0];
	const dlSeen = closes(dl);
	const el = await render(dl);
	byText(el, "button", OFFER)!.click();
	const si = __modals[1];
	const sel = await render(si);
	inputs(sel)[0].value = TOKEN;
	byText(sel, "button", "Sign in")!.click();
	await flush();
	assert.equal(h.settings.accountToken, TOKEN);
	assert.equal(dlSeen.closed, true, "the signed-out Download dialog closes");
	assert.equal(__modals.length, 3);
	const again = __modals[2];
	assert.ok(again instanceof WorldDownloadModal);
	const el2 = await render(again);
	await flush();
	assert.match(el2.allText(), /Signed in as tess/);
	assert.match(el2.allText(), /Hyperion/);
	assert.equal(byText(el2, "button", OFFER), undefined);
});

// --- the Create world dialog ------------------------------------------------

test("Create world, signed out: Create with account opens the Sign in dialog, and after it the dialog is signed in with the name kept", async () => {
	reset();
	keel();
	const { app } = makeApp();
	const h = host(app, false);
	const cmd = new CreateWorldCommand(
		app as never,
		{} as PluginManifest,
		undefined,
		() => (h.settings.accountToken ? { token: h.settings.accountToken, username: h.settings.accountUsername } : null),
		undefined,
		(then) => openSignIn(asPlugin(h), { then })
	);
	void cmd.execute();
	const cw = __modals[0];
	assert.ok(cw instanceof CreateWorldModal);
	const cwSeen = closes(cw);
	const el = await render(cw);
	assert.match(el.allText(), /Creating a world on onlyworlds\.com goes through your account\. Create with account signs you in first; then create it\./);
	assert.doesNotMatch(el.allText(), /Settings, OnlyWorlds account/);
	inputs(el)[0].value = "Atlas";
	byText(el, "button", "Create with account")!.click();
	assert.equal(__modals.length, 2);
	assert.ok(__modals[1] instanceof SignInModal);
	assert.ok(!__notices.includes(CREATE_SIGN_IN_FIRST), "no longer only the sentence");
	const sel = await render(__modals[1]);
	inputs(sel)[0].value = TOKEN;
	byText(sel, "button", "Sign in")!.click();
	await flush();
	assert.equal(cwSeen.closed, false, "the Create dialog stays");
	const fields = inputs(el);
	assert.equal(fields[0].value, "Atlas", "the name is kept");
	assert.equal(fields[1].hidden, false, "the PIN field is shown, signed in");
	assert.match(el.allText(), /Signed in as tess: the world is created under that account/);
});

test("Create world, signed out: Take online opens the Sign in dialog, and after it the dialog is signed in with the name and the local world kept", async () => {
	reset();
	keel();
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Atlas/World.md", "- **API Key:** local\n");
	await vault.seed("OnlyWorlds/Worlds/Brume/World.md", "- **API Key:** local\n");
	const h = host(app, false);
	let submitted: unknown = null;
	const cw = new CreateWorldModal(app as never, (d) => (submitted = d), undefined, (then) => openSignIn(asPlugin(h), { then }));
	const cwSeen = closes(cw);
	const el = await render(cw);
	inputs(el)[0].value = "Draft name";
	const select = el.all().find((c) => c.tag === "select")!;
	select.value = "Brume";
	byText(el, "button", "Take online")!.click();
	assert.equal(__modals.length, 1);
	assert.ok(__modals[0] instanceof SignInModal);
	assert.ok(!__notices.includes(CREATE_SIGN_IN_FIRST), "no longer only the sentence");
	assert.equal(submitted, null, "nothing submitted signed out");
	const sel = await render(__modals[0]);
	inputs(sel)[0].value = TOKEN;
	byText(sel, "button", "Sign in")!.click();
	await flush();
	assert.equal(cwSeen.closed, false, "the Create dialog stays");
	assert.equal(inputs(el)[0].value, "Draft name", "the name is kept");
	assert.equal(el.all().find((c) => c.tag === "select")!.value, "Brume", "the local world is kept");
	assert.match(el.allText(), /Signed in as tess: the world is created under that account/);
});

// --- the new files run on mobile --------------------------------------------

test("the new files import no Node or Electron module (the plugin is not desktop-only)", () => {
	const nodeNames = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
	for (const file of ["account/sign-in.ts", "Modals/SignInModal.ts"]) {
		const src = readFileSync(join(ROOT, file), "utf8");
		const specs = [...src.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
		assert.ok(specs.length > 0, `${file}: its imports were read`);
		for (const s of specs) {
			assert.ok(!nodeNames.has(s) && s !== "electron" && !s.startsWith("electron/"), `${file} imports ${s}`);
		}
		assert.ok(!/\brequire\(/.test(src), `${file} calls require`);
	}
});
