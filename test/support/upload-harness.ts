/**
 * An Upload World harness for the round C tests: the REAL ExportWorldCommand
 * (collect + upload) over the in-memory vault, the v2 client's network
 * methods stubbed on its prototype; every dialog answered with `answer`.
 */
import { makeApp, __notices, __modals } from "./obsidian-mock";
import { WorldService } from "../../Scripts/WorldService";
import { ExportWorldCommand } from "../../Commands/ExportWorldCommand";
import { V2ApiError, V2Client } from "../../client-v2";

export const UPLOAD_WID = "019a0000-0000-7000-8000-0000000000ee";

type Proto = Record<string, unknown>;

export interface UploadOpts {
	/** Notes, relative to world W's Elements folder. */
	notes: Record<string, string>;
	/** The change feed from the epoch. */
	changes: unknown[];
	/** The plugin's deleted list for the world. */
	deleted?: string[];
	/** The plugin's hidden list for the world. */
	hidden?: string[];
	/** The plugin's left-view list for the world. */
	leftView?: string[];
	/** The plugin's last-known list for the world. */
	lastKnown?: string[];
	answer?: boolean;
	/** The world's change_seq index (`.ow-seq.json`). */
	seqs?: Record<string, number>;
	/** Ids whose PATCH keel refuses with 412 (changed since the note was pulled). */
	stale?: string[];
	/** The change_seq a PATCH answers with, per id. */
	answerSeq?: (id: string) => number | undefined;
}

export async function harnessUpload(o: UploadOpts) {
	const proto = V2Client.prototype as unknown as Proto;
	const saved: Proto = {};
	for (const k of ["changesWalk", "bulkCreate", "update", "getWorld", "patchWorld"]) saved[k] = proto[k];
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	for (const [rel, c] of Object.entries(o.notes)) await vault.seed(`OnlyWorlds/Worlds/W/Elements/${rel}`, c);
	const bulkSent: Record<string, unknown>[] = [];
	const patches: Record<string, Record<string, unknown>> = {};
	proto.getWorld = async () => ({ id: UPLOAD_WID, name: "W" });
	proto.changesWalk = async () => ({ changes: o.changes, cursor: "c9", head: 9 });
	proto.bulkCreate = async (items: { element: Record<string, unknown> }[]) => {
		bulkSent.push(...items.map((i) => i.element));
		return { errors: false, items: items.map((i) => ({ status: 201, id: i.element.id })) };
	};
	if (o.seqs) await vault.adapter.write("OnlyWorlds/Worlds/W/.ow-seq.json", JSON.stringify(o.seqs));
	const ifMatch: Record<string, number | null | undefined> = {};
	proto.update = async (_t: string, id: string, b: Record<string, unknown>, opts?: { ifMatch?: number | null }) => {
		ifMatch[id] = opts?.ifMatch;
		if (o.stale?.includes(id)) throw new V2ApiError(412, "precondition_failed", "The element has changed since change_seq 4 (now 5).", null);
		patches[id] = b;
		const seq = o.answerSeq?.(id);
		return seq === undefined ? {} : { id, change_seq: seq };
	};
	proto.patchWorld = async () => ({});
	const plugin = {
		settings: { apiKey: "", deletedOnServer: { [UPLOAD_WID]: o.deleted ?? [] } as Record<string, string[]>, hiddenOnServer: { [UPLOAD_WID]: o.hidden ?? [] } as Record<string, string[]>, leftView: { [UPLOAD_WID]: o.leftView ?? [] } as Record<string, string[]>, lastKnown: { [UPLOAD_WID]: o.lastKnown ?? [] } as Record<string, string[]>, syncCursors: {} },
		saveSettings: async () => {},
		pinCache: { get: async () => null },
	};
	const cmd = new ExportWorldCommand(app, {} as never, new WorldService(app), plugin as never);
	__notices.length = 0;
	__modals.length = 0;
	let done = false;
	try {
		const data = await cmd.collectWorldData("W");
		const run = (cmd as unknown as { uploadViaV2(pin: number, w: string, d: unknown): Promise<void> })
			.uploadViaV2(1234, "W", data)
			.finally(() => (done = true));
		while (!done) {
			await new Promise((r) => setImmediate(r));
			for (const m of __modals.splice(0)) {
				const d = m as unknown as { choose?: (b: boolean) => void };
				if (typeof d.choose === "function") d.choose(o.answer ?? false);
			}
		}
		await run;
	} finally {
		for (const [k, v] of Object.entries(saved)) proto[k] = v;
	}
	const seqFile = vault.dotfiles.get("OnlyWorlds/Worlds/W/.ow-seq.json");
	return { bulkSent, patches, ifMatch, seqIndex: (seqFile ? JSON.parse(seqFile) : {}) as Record<string, number>, notices: [...__notices], settings: plugin.settings };
}
