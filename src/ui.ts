import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Plan } from "./plan.ts";
import type { WorkstreamState } from "./workstream.ts";

const WIDGET = "pi-workstream";
const SUMMARY_PROMPT = [
	"Summarize one completed workstream batch.",
	"Return summary text only.",
	"Preserve requirements, decisions, paths, commands, errors, side effects, validation state, and unfinished work.",
	"Do not invent results or remove uncertainty.",
].join("\n");

export function status(state: WorkstreamState, plan?: Plan): string {
	if (state.phase === "idle") return "Workstream: idle";
	if (state.phase === "complete") return `Workstream: complete · plan ${state.planId.slice(0, 8)}`;
	if (state.phase === "failed") return `Workstream: failed · ${state.code}`;
	const batch = plan?.batches.find((item) => item.id === state.batch.batchId);
	const progress = `${state.batch.bitmap.filter(Boolean).length}/${state.batch.bitmap.length}`;
	const task =
		state.phase === "running"
			? ` · task ${state.taskIndex + 1}`
			: state.phase === "paused"
				? ` · next task ${state.nextTaskIndex + 1}`
				: "";
	return `Workstream: ${state.phase} · ${batch?.title ?? state.batch.batchId.slice(0, 8)} · ${progress}${task}`;
}

export function render(ctx: ExtensionContext, state: WorkstreamState, plan?: Plan): void {
	if (!ctx.hasUI) return;
	if (state.phase === "idle") {
		ctx.ui.setWidget(WIDGET, undefined);
		ctx.ui.setStatus(WIDGET, undefined);
		return;
	}
	const line = status(state, plan);
	ctx.ui.setWidget(WIDGET, [line], { placement: "aboveEditor" });
	ctx.ui.setStatus(WIDGET, line);
}

export async function reviewSummary(ctx: ExtensionCommandContext, source: string): Promise<string | undefined> {
	if (!ctx.model) throw new Error("No model is available for the batch summary.");
	const response = await ctx.modelRegistry.complete(ctx.model, {
		systemPrompt: SUMMARY_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: source }], timestamp: Date.now() }],
	});
	const draft = response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!draft) throw new Error("The summary model returned no text.");
	return (await ctx.ui.editor("Review completed batch summary", draft))?.trim() || undefined;
}
