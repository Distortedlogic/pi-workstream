export const WORKSTREAM_STATE_ENTRY = "pi-workstream/state";
export const WORKSTREAM_STATE_VERSION = 1;

export type WorkstreamRunStatus = "idle" | "running" | "reviewing" | "failed" | "complete";

/** Durable identity and current-batch data for one integrated plan run. */
export interface WorkstreamRunState {
	v: typeof WORKSTREAM_STATE_VERSION;
	status: WorkstreamRunStatus;
	runId?: string;
	planId?: string;
	batchId?: string;
	structuralRevision?: string;
	fileRevision?: string;
	checkboxBitmap?: boolean[];
}

export function emptyWorkstreamRunState(): WorkstreamRunState {
	return { v: WORKSTREAM_STATE_VERSION, status: "idle" };
}
