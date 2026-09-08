import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkstreamRuntime } from "./engine/runtime.ts";

function notifyStatus(runtime: WorkstreamRuntime, ctx: Parameters<WorkstreamRuntime["status"]>[0]): void {
	ctx.ui.notify(runtime.status(ctx).join("\n"), "info");
}

export function registerWorkstreamCommand(pi: ExtensionAPI, runtime: WorkstreamRuntime): void {
	pi.registerCommand("workstream", {
		description: "Run and control one plan-bound workstream",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const separator = args.indexOf(" ");
			const action = (separator === -1 ? args : args.slice(0, separator)).toLowerCase();
			const value = separator === -1 ? "" : args.slice(separator + 1).trim();
			try {
				switch (action || "status") {
					case "plan": {
						const markdown = await ctx.ui.editor(
							"Create or refine a workstream plan",
							"# Plan title\n\n## Batch 1\n\n- [ ] First task\n",
						);
						if (!markdown?.trim()) return;
						const plan = await runtime.savePlan(markdown);
						ctx.ui.notify(`Saved ${plan.path}`, "info");
						return;
					}
					case "run":
						if (!value) throw new Error("Usage: /workstream run <plan-path>");
						await runtime.start(value, ctx);
						break;
					case "pause":
						await runtime.pause(ctx, value || "Paused by user.");
						break;
					case "resume":
						await runtime.resume(ctx);
						break;
					case "review":
						await runtime.continueReview(ctx);
						break;
					case "reset":
						await runtime.reset(ctx);
						break;
					case "status":
						break;
					default:
						throw new Error("Usage: /workstream <plan|run|status|pause|resume|review|reset>");
				}
				notifyStatus(runtime, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
