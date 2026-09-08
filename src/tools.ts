import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkstreamRuntime } from "./engine/runtime.ts";

const WorkstreamToolSchema = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("complete_task"), Type.Literal("fail_task")]),
	message: Type.Optional(Type.String({ description: "Failure reason for fail_task" })),
});

function details(runtime: WorkstreamRuntime, ctx: Parameters<WorkstreamRuntime["state"]>[0]) {
	const state = runtime.state(ctx);
	return {
		phase: state.phase,
		...("run" in state ? { runId: state.run.runId, planId: state.run.planId } : {}),
		...("batch" in state ? { batchId: state.batch.batchId } : {}),
	};
}

export function registerWorkstreamTool(pi: ExtensionAPI, runtime: WorkstreamRuntime): void {
	pi.registerTool({
		name: "workstream",
		label: "Workstream",
		description: "Read or advance the one active plan-bound workstream task.",
		promptSnippet: "Complete only the active workstream task before advancing the plan.",
		promptGuidelines: [
			"Use workstream complete_task only after the active task is fully complete.",
			"Use workstream fail_task when the active task cannot be completed.",
			"Do not start, queue, or select another task. The workstream engine controls task order.",
		],
		parameters: WorkstreamToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "complete_task") await runtime.completeCurrentTask(ctx);
			if (params.action === "fail_task") {
				if (!params.message?.trim()) throw new Error("message is required for fail_task");
				await runtime.fail(ctx, params.message.trim());
			}
			return {
				content: [{ type: "text", text: runtime.status(ctx).join("\n") }],
				details: details(runtime, ctx),
			};
		},
	});
}
