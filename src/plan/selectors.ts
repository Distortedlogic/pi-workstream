import type { BatchId, PlanBatch, PlanDocument, PlanTask } from "./model.ts";

export function batchById(plan: PlanDocument, batchId: BatchId): PlanBatch | undefined {
	return plan.batches.find((batch) => batch.id === batchId);
}

export function firstIncompleteBatch(plan: PlanDocument): PlanBatch | undefined {
	return plan.batches.find((batch) => batch.checkboxBitmap.some((checked) => !checked));
}

export function nextIncompleteBatch(plan: PlanDocument, currentBatchId: BatchId): PlanBatch | undefined {
	const current = batchById(plan, currentBatchId);
	if (!current) return undefined;
	return plan.batches
		.slice(current.index + 1)
		.find((batch) => batch.checkboxBitmap.some((checked) => !checked));
}

export function nextIncompleteTask(batch: PlanBatch, afterIndex = -1): PlanTask | undefined {
	return batch.tasks.find((task) => task.index > afterIndex && !task.checked);
}

export function isBatchComplete(batch: PlanBatch): boolean {
	return batch.tasks.length > 0 && batch.checkboxBitmap.every(Boolean);
}
