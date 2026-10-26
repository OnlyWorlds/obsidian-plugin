/**
 * A small Save Element harness for the round C tests: notes seeded in world W,
 * a server held in a map (everything else 404s), every dialog answered yes.
 * Returns what was sent, the calls in order and the notices shown.
 */
import type { TFile } from "obsidian";
import { makeApp, __notices, __modals } from "./obsidian-mock";
import { SaveElementCommand } from "../../Commands/SaveElementCommand";
import { V2ApiError } from "../../client-v2";

export const HARNESS_WID = "019e0000-0000-7000-8000-0000000000ee";

export interface HarnessOpts {
	notes: Record<string, string>;
	/** The note saved, relative to the world's Elements folder. */
	save: string;
	/** Elements on the server: id -> its body. */
	server?: Record<string, Record<string, unknown>>;
	manual?: boolean;
	/** The status keel answers for each /bulk item (default 201). */
	bulkStatus?: (id: string) => number;
	/** The plugin's stored deleted list for the world. */
	deleted?: string[];
	/** The plugin's stored hidden list for the world. */
	hidden?: string[];
	/** The plugin's stored left-view list for the world. */
	leftView?: string[];
	/** The plugin's stored last-known list for the world (whole notes kept after a role reset). */
	lastKnown?: string[];
	/** The stored (Download's) cursor for the world. */
	cursor?: { cursor: string; head: number };
	/** What the change feed reports from any cursor. */
	feed?: { id: string; op: string }[];
	/** Ids keel answers 410 (deleted in this world). */
	gone?: string[];
	/** The element body keel answers an update or a create of an id with (default: `{}` for an update, the sent body for a create). */
	answer?: Record<string, Record<string, unknown>>;
}

export async function harnessSave(o: HarnessOpts) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const files: Record<string, TFile> = {};
	for (const [rel, c] of Object.entries(o.notes)) {
		files[rel] = (await vault.seed(`OnlyWorlds/Worlds/W/Elements/${rel}`, c)) as unknown as TFile;
	}
	const server = new Map(Object.entries(o.server ?? {}));
	const calls: string[] = [];
	const sent: Record<string, unknown>[] = [];
	const bulkOpts: unknown[] = [];
	const client = {
		getWorld: async () => ({ id: HARNESS_WID, name: "W" }),
		changesWalk: async (since?: string) => {
			calls.push(`changes ${since ?? "epoch"}`);
			return { changes: o.feed ?? [], cursor: "c1", head: 1 };
		},
		get: async (type: string, id: string) => {
			calls.push(`get ${type} ${id}`);
			const el = server.get(id);
			if (el) return { id, ...el };
			if (o.gone?.includes(id)) throw new V2ApiError(410, "gone", "API Error 410", null);
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		create: async (type: string, b: Record<string, unknown>) => {
			calls.push(`create ${type}`);
			sent.push(b);
			server.set(String(b.id), b);
			return o.answer?.[String(b.id)] ?? b;
		},
		update: async (type: string, id: string, b: Record<string, unknown>) => {
			calls.push(`update ${type} ${id}`);
			sent.push(b);
			return o.answer?.[id] ?? {};
		},
		bulkCreate: async (items: { type: string; element: Record<string, unknown> }[], opts?: unknown) => {
			calls.push("bulk");
			bulkOpts.push(opts);
			for (const i of items) sent.push(i.element);
			const statuses = items.map((i) => o.bulkStatus?.(String(i.element.id)) ?? 201);
			return {
				errors: statuses.some((s) => s !== 201 && s !== 200),
				items: items.map((i, n) => ({ status: statuses[n], id: i.element.id })),
			};
		},
	};
	const settings = {
		apiKey: "",
		deletedOnServer: (o.deleted ? { [HARNESS_WID]: o.deleted } : {}) as Record<string, string[]>,
		hiddenOnServer: (o.hidden ? { [HARNESS_WID]: o.hidden } : {}) as Record<string, string[]>,
		leftView: (o.leftView ? { [HARNESS_WID]: o.leftView } : {}) as Record<string, string[]>,
		lastKnown: (o.lastKnown ? { [HARNESS_WID]: o.lastKnown } : {}) as Record<string, string[]>,
		syncCursors: (o.cursor ? { [HARNESS_WID]: o.cursor } : {}) as Record<string, { cursor: string; head: number }>,
	};
	const plugin = { settings, saveSettings: async () => {}, buildV2Client: async () => client };
	__notices.length = 0;
	__modals.length = 0;
	let done = false;
	const run = new SaveElementCommand(app, plugin as never)
		.execute(files[o.save], { manual: o.manual ?? true })
		.finally(() => (done = true));
	while (!done) {
		await new Promise((r) => setImmediate(r));
		for (const m of __modals.splice(0)) {
			const d = m as unknown as { choose?: (b: boolean) => void };
			if (typeof d.choose === "function") d.choose(true);
		}
	}
	return { result: await run, calls, sent, bulkOpts, notices: [...__notices], vault, app, files, settings };
}
