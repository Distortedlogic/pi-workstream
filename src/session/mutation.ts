import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { WORKSTREAM_STATE_ENTRY, type RunBinding } from "../engine/state.ts";
import type { BatchSnapshot } from "../plan/model.ts";
import type { CompressionCheckpoint } from "../engine/state.ts";

export const BATCH_START_ENTRY = "pi-workstream/batch-start";
export const COMPRESSION_ENTRY = "pi-workstream/compression";
export const COMPRESSION_TAIL = "pi-workstream/compressed-tail";

function lastEntryId(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries() as Array<{ id?: string }>;
	return entries.at(-1)?.id;
}

export function appendBatchStart(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	run: RunBinding,
	batch: BatchSnapshot,
): string {
	pi.appendEntry(BATCH_START_ENTRY, {
		v: 1,
		runId: run.runId,
		planId: run.planId,
		batchId: batch.batchId,
	});
	const id = lastEntryId(ctx);
	if (!id) throw new Error("The batch start marker was not written.");
	return id;
}

export async function navigateToBatchStart(
	ctx: ExtensionCommandContext,
	batchStartEntryId: string,
	checkpoint: CompressionCheckpoint,
): Promise<void> {
	const branch = [...ctx.sessionManager.getBranch()] as Array<{
		id?: string;
		type?: string;
		customType?: string;
	}>;
	const sourceIndex = branch.findIndex((entry) => entry.id === checkpoint.sourceLeafId);
	const unexpectedTail = branch
		.slice(sourceIndex + 1)
		.some((entry) => entry.type !== "custom" || entry.customType !== WORKSTREAM_STATE_ENTRY);
	if (sourceIndex === -1 || unexpectedTail) throw new Error("The session changed before compression could be applied.");
	const navigation = await ctx.navigateTree(batchStartEntryId, { summarize: false });
	if (navigation.cancelled) throw new Error("Compression navigation was cancelled.");
}

export function appendCompression(
	pi: ExtensionAPI,
	run: RunBinding,
	batch: BatchSnapshot,
	checkpoint: CompressionCheckpoint,
	approvedSummary: string,
): void {
	const details = {
		v: 1,
		runId: run.runId,
		planId: run.planId,
		batchId: batch.batchId,
		operationId: checkpoint.operationId,
		sourceLeafId: checkpoint.sourceLeafId,
		selectedEntryIds: checkpoint.selectedEntryIds,
		sourceSha256: checkpoint.sourceSha256,
	};
	pi.sendMessage(
		{
			customType: COMPRESSION_TAIL,
			content: approvedSummary.trim(),
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	pi.appendEntry(COMPRESSION_ENTRY, details);
}
