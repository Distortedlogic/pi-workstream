import { Value } from "typebox/value";
import type { BatchSnapshot } from "../plan/model.ts";
import type { WorkstreamState } from "./state.ts";
import { WorkstreamStateSchema } from "./state.ts";

export const ERR_INVALID_STATE = "The workstream state is invalid.";
export const ERR_PLAN_MISMATCH = "The bound plan is missing, duplicated, or different.";
export const ERR_BATCH_CHANGED = "The current plan batch changed before compression could be applied.";

export function sameBatchIdentity(left: BatchSnapshot, right: BatchSnapshot): boolean {
	return (
		left.planId === right.planId &&
		left.batchId === right.batchId &&
		left.structuralRevision === right.structuralRevision
	);
}

export function sameBitmap(left: readonly boolean[], right: readonly boolean[]): boolean {
	return left.length === right.length && left.every((checked, index) => checked === right[index]);
}

export function assertWorkstreamState(state: WorkstreamState): void {
	if (!Value.Check(WorkstreamStateSchema, state)) throw new Error(ERR_INVALID_STATE);
	if ("batch" in state && state.batch.planId !== state.run.planId) throw new Error(ERR_INVALID_STATE);
	if (state.phase === "dispatching" || state.phase === "executing" || state.phase === "pausing") {
		if (state.currentTaskIndex >= state.batch.checkboxBitmap.length) throw new Error(ERR_INVALID_STATE);
	}
	if (state.phase === "paused" && state.nextTaskIndex >= state.batch.checkboxBitmap.length) {
		throw new Error(ERR_INVALID_STATE);
	}
	if (
		(state.phase === "preparing_review" ||
			state.phase === "reviewing" ||
			state.phase === "revalidating" ||
			state.phase === "applying") &&
		state.preCompletionBitmap.length !== state.batch.checkboxBitmap.length
	) {
		throw new Error(ERR_INVALID_STATE);
	}
	if (
		(state.phase === "preparing_review" ||
			state.phase === "reviewing" ||
			state.phase === "revalidating" ||
			state.phase === "applying") &&
		state.completedTaskIndex >= state.batch.checkboxBitmap.length
	) {
		throw new Error(ERR_INVALID_STATE);
	}
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled workstream variant: ${JSON.stringify(value)}`);
}
