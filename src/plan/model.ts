export type PlanId = string;
export type BatchId = string;

export interface PlanTask {
	index: number;
	text: string;
	checked: boolean;
	checkboxOffset: number;
}

export interface PlanBatch {
	id: BatchId;
	index: number;
	title: string;
	tasks: readonly PlanTask[];
	checkboxBitmap: readonly boolean[];
}

/** The path and Markdown stay in memory. They are never part of durable run state. */
export interface PlanDocument {
	path: string;
	markdown: string;
	title: string;
	canonicalFilename: string;
	planId: PlanId;
	fileRevision: string;
	structuralRevision: string;
	batches: readonly PlanBatch[];
}

export interface BatchSnapshot {
	planId: PlanId;
	batchId: BatchId;
	structuralRevision: string;
	fileRevision: string;
	checkboxBitmap: boolean[];
}

export function snapshotBatch(plan: PlanDocument, batch: PlanBatch): BatchSnapshot {
	return {
		planId: plan.planId,
		batchId: batch.id,
		structuralRevision: plan.structuralRevision,
		fileRevision: plan.fileRevision,
		checkboxBitmap: [...batch.checkboxBitmap],
	};
}

export function sameBatchSnapshot(left: BatchSnapshot, right: BatchSnapshot): boolean {
	return (
		left.planId === right.planId &&
		left.batchId === right.batchId &&
		left.structuralRevision === right.structuralRevision &&
		left.fileRevision === right.fileRevision &&
		left.checkboxBitmap.length === right.checkboxBitmap.length &&
		left.checkboxBitmap.every((checked, index) => checked === right.checkboxBitmap[index])
	);
}
