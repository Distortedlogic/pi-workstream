import type { BatchSnapshot } from "../plan/model.ts";
import type { CompressionCheckpoint, WorkstreamState } from "./state.ts";

export type WorkstreamEffect =
	| { type: "persist"; state: WorkstreamState }
	| { type: "dispatch_task"; batch: BatchSnapshot; taskIndex: number }
	| {
			type: "prepare_review";
			batch: BatchSnapshot;
			batchStartEntryId: string;
			completedTaskIndex: number;
			preCompletionBitmap: readonly boolean[];
	  }
	| { type: "open_review"; compression: CompressionCheckpoint }
	| {
			type: "revalidate";
			acceptedBatch: BatchSnapshot;
			completedTaskIndex: number;
			preCompletionBitmap: readonly boolean[];
			approvedSummary: string;
	  }
	| {
			type: "apply_compression";
			acceptedBatch: BatchSnapshot;
			compression: CompressionCheckpoint;
			approvedSummary: string;
	  }
	| { type: "notify"; level: "info" | "warning" | "error"; message: string };

export interface Reduction {
	state: WorkstreamState;
	effects: readonly WorkstreamEffect[];
}
