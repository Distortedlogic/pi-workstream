import { sameBatchSnapshot } from "../plan/model.ts";
import { type Reduction, type WorkstreamEffect } from "./effects.ts";
import type { WorkstreamEvent } from "./events.ts";
import { ERR_BATCH_CHANGED, assertNever, sameBatchIdentity, sameBitmap } from "./invariants.ts";
import { IDLE_STATE, WORKSTREAM_STATE_VERSION, type WorkstreamState } from "./state.ts";

function result(state: WorkstreamState, ...effects: WorkstreamEffect[]): Reduction {
	return { state, effects: [{ type: "persist", state }, ...effects] };
}

function invalid(state: WorkstreamState, event: WorkstreamEvent): Reduction {
	return {
		state,
		effects: [{ type: "notify", level: "error", message: `Event ${event.type} is invalid during ${state.phase}.` }],
	};
}

function firstUnchecked(bitmap: readonly boolean[]): number | undefined {
	const index = bitmap.findIndex((checked) => !checked);
	return index === -1 ? undefined : index;
}

function isExactTaskCompletion(before: readonly boolean[], after: readonly boolean[], taskIndex: number): boolean {
	return (
		before.length === after.length &&
		before[taskIndex] === false &&
		after[taskIndex] === true &&
		before.every((checked, index) => index === taskIndex || checked === after[index])
	);
}

export function reduceWorkstream(state: WorkstreamState, event: WorkstreamEvent): Reduction {
	if (event.type === "reset_requested") return result(IDLE_STATE);
	if (event.type === "operation_failed") {
		if ("batch" in state) {
			return result({
				v: WORKSTREAM_STATE_VERSION,
				phase: "failed",
				scope: "run",
				run: state.run,
				batch: state.batch,
				batchStartEntryId: state.batchStartEntryId,
				code: event.code,
				message: event.message,
			});
		}
		return result({
			v: WORKSTREAM_STATE_VERSION,
			phase: "failed",
			scope: "unbound",
			code: event.code,
			message: event.message,
		});
	}

	switch (state.phase) {
		case "idle": {
			if (event.type !== "run_started") return invalid(state, event);
			const taskIndex = firstUnchecked(event.batch.checkboxBitmap);
			if (taskIndex === undefined) return invalid(state, event);
			const next: WorkstreamState = {
				v: WORKSTREAM_STATE_VERSION,
				phase: "dispatching",
				run: event.run,
				batch: event.batch,
				batchStartEntryId: event.batchStartEntryId,
				currentTaskIndex: taskIndex,
			};
			return result(next, { type: "dispatch_task", batch: event.batch, taskIndex });
		}
		case "dispatching": {
			if (event.type !== "task_delivered" || event.taskIndex !== state.currentTaskIndex) {
				return invalid(state, event);
			}
			return result({ ...state, phase: "executing" });
		}
		case "executing":
		case "pausing": {
			if (state.phase === "executing" && event.type === "pause_requested") {
				return result({ ...state, phase: "pausing", reason: event.reason });
			}
			if (event.type === "task_finished") {
				if (
					state.currentTaskIndex !== event.taskIndex ||
					!sameBatchIdentity(state.batch, event.freshBatch) ||
					!isExactTaskCompletion(state.batch.checkboxBitmap, event.freshBatch.checkboxBitmap, event.taskIndex)
				) {
					return reduceWorkstream(state, {
						type: "operation_failed",
						code: "batch_changed",
						message: ERR_BATCH_CHANGED,
					});
				}
				const nextTaskIndex = firstUnchecked(event.freshBatch.checkboxBitmap);
				if (nextTaskIndex !== undefined && state.phase === "pausing") {
					return result({
						v: WORKSTREAM_STATE_VERSION,
						phase: "paused",
						run: state.run,
						batch: event.freshBatch,
						batchStartEntryId: state.batchStartEntryId,
						nextTaskIndex,
						reason: state.reason,
					});
				}
				if (nextTaskIndex !== undefined) {
					const next: WorkstreamState = {
						v: WORKSTREAM_STATE_VERSION,
						phase: "dispatching",
						run: state.run,
						batch: event.freshBatch,
						batchStartEntryId: state.batchStartEntryId,
						currentTaskIndex: nextTaskIndex,
					};
					return result(next, { type: "dispatch_task", batch: event.freshBatch, taskIndex: nextTaskIndex });
				}
				const next: WorkstreamState = {
					v: WORKSTREAM_STATE_VERSION,
					phase: "preparing_review",
					run: state.run,
					batch: event.freshBatch,
					batchStartEntryId: state.batchStartEntryId,
					completedTaskIndex: event.taskIndex,
					preCompletionBitmap: [...state.batch.checkboxBitmap],
				};
				return result(next);
			}
			return invalid(state, event);
		}
		case "paused": {
			if (event.type !== "resume_requested") return invalid(state, event);
			const next: WorkstreamState = {
				v: WORKSTREAM_STATE_VERSION,
				phase: "dispatching",
				run: state.run,
				batch: state.batch,
				batchStartEntryId: state.batchStartEntryId,
				currentTaskIndex: state.nextTaskIndex,
			};
			return result(next, { type: "dispatch_task", batch: state.batch, taskIndex: state.nextTaskIndex });
		}
		case "preparing_review": {
			if (event.type !== "review_ready") return invalid(state, event);
			const next: WorkstreamState = { ...state, phase: "reviewing", compression: event.compression };
			return result(next);
		}
		case "reviewing": {
			if (event.type !== "summary_saved" || !event.approvedSummary.trim()) return invalid(state, event);
			const next: WorkstreamState = { ...state, phase: "revalidating" };
			return result(next, {
				type: "revalidate",
				acceptedBatch: state.batch,
				completedTaskIndex: state.completedTaskIndex,
				preCompletionBitmap: state.preCompletionBitmap,
				approvedSummary: event.approvedSummary,
			});
		}
		case "revalidating": {
			if (event.type !== "revalidation_succeeded") return invalid(state, event);
			if (
				!sameBatchSnapshot(state.batch, event.freshBatch) ||
				!sameBitmap(state.preCompletionBitmap, event.freshPreCompletionBitmap)
			) {
				return reduceWorkstream(state, {
					type: "operation_failed",
					code: "batch_changed",
					message: ERR_BATCH_CHANGED,
				});
			}
			const next: WorkstreamState = { ...state, phase: "applying" };
			return result(next, {
				type: "apply_compression",
				acceptedBatch: state.batch,
				compression: state.compression,
				approvedSummary: event.approvedSummary,
			});
		}
		case "applying": {
			if (event.type !== "compression_applied") return invalid(state, event);
			if (!event.nextBatch) {
				return result({ v: WORKSTREAM_STATE_VERSION, phase: "complete", run: state.run });
			}
			if (!event.nextBatchStartEntryId || event.nextBatch.planId !== state.run.planId) return invalid(state, event);
			const taskIndex = firstUnchecked(event.nextBatch.checkboxBitmap);
			if (taskIndex === undefined) return invalid(state, event);
			const next: WorkstreamState = {
				v: WORKSTREAM_STATE_VERSION,
				phase: "dispatching",
				run: state.run,
				batch: event.nextBatch,
				batchStartEntryId: event.nextBatchStartEntryId,
				currentTaskIndex: taskIndex,
			};
			return result(next, { type: "dispatch_task", batch: event.nextBatch, taskIndex });
		}
		case "failed":
		case "complete":
			return invalid(state, event);
		default:
			return assertNever(state);
	}
}
