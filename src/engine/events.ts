import type { BatchSnapshot } from "../plan/model.ts";
import type { CompressionCheckpoint, RunBinding } from "./state.ts";

export type WorkstreamEvent =
	| { type: "run_started"; run: RunBinding; batch: BatchSnapshot; batchStartEntryId: string }
	| { type: "task_delivered"; taskIndex: number }
	| { type: "task_finished"; taskIndex: number; freshBatch: BatchSnapshot }
	| { type: "pause_requested"; reason: string }
	| { type: "resume_requested" }
	| { type: "review_ready"; compression: CompressionCheckpoint }
	| { type: "summary_saved"; approvedSummary: string }
	| {
			type: "revalidation_succeeded";
			freshBatch: BatchSnapshot;
			freshPreCompletionBitmap: readonly boolean[];
			approvedSummary: string;
	  }
	| {
			type: "compression_applied";
			nextBatch?: BatchSnapshot;
			nextBatchStartEntryId?: string;
	  }
	| { type: "operation_failed"; code: string; message: string }
	| { type: "reset_requested" };
