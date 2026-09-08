import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SessionEntry, serializeEntries } from "@pi-context-tree/core";
import { type BatchSnapshot, hash } from "./plan.ts";

export const STATE_ENTRY = "pi-workstream/state";
const BATCH_START_ENTRY = "pi-workstream/batch-start";
const COMPRESSION_ENTRY = "pi-workstream/compression";
const COMPRESSION_TAIL = "pi-workstream/compressed-tail";

export interface Compression {
	operationId: string;
	sourceLeafId: string;
	entryIds: string[];
	sourceHash: string;
}

function branch(ctx: ExtensionContext): SessionEntry[] {
	return [...ctx.sessionManager.getBranch()] as SessionEntry[];
}

export function appendBatchStart(pi: ExtensionAPI, ctx: ExtensionContext, runId: string, batch: BatchSnapshot): string {
	pi.appendEntry(BATCH_START_ENTRY, { v: 1, runId, planId: batch.planId, batchId: batch.batchId });
	const id = (ctx.sessionManager.getEntries() as Array<{ id?: string }>).at(-1)?.id;
	if (!id) throw new Error("The batch start marker was not written.");
	return id;
}

export function prepareCompression(ctx: ExtensionContext, batchStartEntryId: string): Compression {
	const entries = branch(ctx);
	const start = entries.findIndex((entry) => entry.id === batchStartEntryId);
	const sourceLeafId = ctx.sessionManager.getLeafId();
	if (start === -1 || !sourceLeafId) throw new Error("The batch session range is not available.");
	const selected = entries.slice(start + 1);
	const source = serializeEntries(selected);
	if (!source.trim()) throw new Error("The completed batch has no session range.");
	return {
		operationId: randomUUID(),
		sourceLeafId,
		entryIds: selected.map((entry) => entry.id),
		sourceHash: hash(source),
	};
}

export function compressionSource(ctx: ExtensionContext, compression: Compression): string {
	const ids = new Set(compression.entryIds);
	const entries = branch(ctx).filter((entry) => ids.has(entry.id));
	if (entries.length !== compression.entryIds.length) throw new Error("The compression source is no longer available.");
	const source = serializeEntries(entries);
	if (hash(source) !== compression.sourceHash) throw new Error("The compression source changed.");
	return source;
}

export async function navigateToBatchStart(
	ctx: ExtensionCommandContext,
	batchStartEntryId: string,
	compression: Compression,
): Promise<void> {
	const entries = branch(ctx);
	const source = entries.findIndex((entry) => entry.id === compression.sourceLeafId);
	const changed = entries
		.slice(source + 1)
		.some((entry) => entry.type !== "custom" || entry.customType !== STATE_ENTRY);
	if (source === -1 || changed) throw new Error("The session changed before compression could be applied.");
	const navigation = await ctx.navigateTree(batchStartEntryId, { summarize: false });
	if (navigation.cancelled) throw new Error("Compression navigation was cancelled.");
}

export function hasCompression(ctx: ExtensionContext, runId: string, batchId: string): boolean {
	return branch(ctx).some((entry) => {
		if (entry.type !== "custom" || entry.customType !== COMPRESSION_ENTRY) return false;
		const data = entry.data as { runId?: string; batchId?: string } | undefined;
		return data?.runId === runId && data.batchId === batchId;
	});
}

export function appendCompression(
	pi: ExtensionAPI,
	runId: string,
	batch: BatchSnapshot,
	compression: Compression,
	summary: string,
): void {
	const details = {
		v: 1,
		runId,
		planId: batch.planId,
		batchId: batch.batchId,
		operationId: compression.operationId,
		sourceLeafId: compression.sourceLeafId,
		selectedEntryIds: compression.entryIds,
		sourceSha256: compression.sourceHash,
	};
	pi.sendMessage(
		{ customType: COMPRESSION_TAIL, content: summary.trim(), display: true, details },
		{ triggerTurn: false },
	);
	pi.appendEntry(COMPRESSION_ENTRY, details);
}
