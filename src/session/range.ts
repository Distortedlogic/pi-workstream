import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sha256 } from "../plan/identity.ts";
import type { CompressionCheckpoint } from "../engine/state.ts";
import { serializeEntries } from "./serialize.ts";
import type { SessionEntry } from "./types.ts";

export interface PreparedCompression {
	checkpoint: CompressionCheckpoint;
	serializedSource: string;
}

function branchEntries(ctx: ExtensionContext): SessionEntry[] {
	return [...ctx.sessionManager.getBranch()] as SessionEntry[];
}

export function prepareCompression(ctx: ExtensionContext, batchStartEntryId: string): PreparedCompression {
	const branch = branchEntries(ctx);
	const startIndex = branch.findIndex((entry) => entry.id === batchStartEntryId);
	const sourceLeafId = ctx.sessionManager.getLeafId();
	if (startIndex === -1 || !sourceLeafId) throw new Error("The batch session range is not available.");
	const selected = branch.slice(startIndex + 1);
	const serializedSource = serializeEntries(selected);
	if (!serializedSource.trim() || selected.length === 0) throw new Error("The completed batch has no session range.");
	return {
		checkpoint: {
			operationId: randomUUID(),
			sourceLeafId,
			selectedEntryIds: selected.map((entry) => entry.id),
			sourceSha256: sha256(serializedSource),
		},
		serializedSource,
	};
}

export function restoreCompressionSource(ctx: ExtensionContext, checkpoint: CompressionCheckpoint): string {
	const selected = new Set(checkpoint.selectedEntryIds);
	const entries = branchEntries(ctx).filter((entry) => selected.has(entry.id));
	if (entries.length !== checkpoint.selectedEntryIds.length) throw new Error("The compression source is no longer available.");
	const serialized = serializeEntries(entries);
	if (sha256(serialized) !== checkpoint.sourceSha256) throw new Error("The compression source changed.");
	return serialized;
}
