import type { PlanBatch, PlanTask } from "../plan/model.ts";

export function taskPrompt(batch: PlanBatch, task: PlanTask): string {
	return [
		`[Workstream batch ${batch.index + 1}: ${batch.title}]`,
		`[Task ${task.index + 1} of ${batch.tasks.length}]`,
		"",
		task.text,
	].join("\n");
}
