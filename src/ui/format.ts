import type { PlanDocument } from "../plan/model.ts";
import type { WorkstreamState } from "../engine/state.ts";

function short(value: string): string {
	return value.slice(0, 8);
}

export function formatWorkstream(state: WorkstreamState, plan?: PlanDocument): string[] {
	if (state.phase === "idle") return ["Workstream: idle"];
	if (state.phase === "complete") return [`Workstream: complete · plan ${short(state.run.planId)}`];
	if (state.phase === "failed") return [`Workstream: failed · ${state.code}`, state.message];
	const batch = plan?.batches.find((candidate) => candidate.id === state.batch.batchId);
	const completed = state.batch.checkboxBitmap.filter(Boolean).length;
	const total = state.batch.checkboxBitmap.length;
	const task =
		state.phase === "dispatching" || state.phase === "executing" || state.phase === "pausing"
			? ` · task ${state.currentTaskIndex + 1}`
			: state.phase === "paused"
				? ` · next task ${state.nextTaskIndex + 1}`
				: "";
	return [
		`Workstream: ${state.phase} · ${batch?.title ?? short(state.batch.batchId)} · ${completed}/${total}${task}`,
	];
}
