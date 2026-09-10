import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Plan } from "./plan.ts";
import type { WorkstreamState } from "./workstream.ts";

const WIDGET = "pi-workstream-plan";
const SUMMARY_PROMPT = [
	"Summarize the completed execution of one task-plan batch.",
	"Return summary text only.",
	"Preserve files changed, implementation decisions, exact commands and test results, failures, unresolved work, and commit hashes.",
	"Do not invent results or remove uncertainty.",
].join("\n");

export function status(state: WorkstreamState): string {
	if (state.phase === "idle") return "Workstream: idle";
	if (state.phase === "planning") return state.planId ? "Workstream: planning · plan bound" : "Workstream: planning";
	if (state.phase === "complete") return `Workstream: complete · ${state.planId.slice(0, 8)}`;
	if (state.phase === "paused") return `Workstream: paused · ${state.code}`;
	return `Workstream: ${state.phase} · batch ${state.batchOrdinal + 1}`;
}

function planLines(plan: Plan, state: WorkstreamState): string[] {
	const activeBatchId = "batchId" in state ? state.batchId : undefined;
	const lines = [`Tasks · ${plan.title}`];
	for (const batch of plan.batches) {
		const active = batch.id === activeBatchId ? "▶" : batch.tasks.every((task) => task.checked) ? "✓" : "○";
		lines.push(`${active} ${batch.title}`);
		for (const task of batch.tasks) lines.push(`  ${task.checked ? "[x]" : "[ ]"} ${task.text}`);
	}
	return lines;
}

export function render(ctx: ExtensionContext, state: WorkstreamState, plan?: Plan): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WIDGET, state.phase === "idle" ? undefined : status(state));
	ctx.ui.setWidget(WIDGET, plan ? planLines(plan, state) : undefined, { placement: "aboveEditor" });
}

export function showPlan(ctx: ExtensionContext, plan: Plan): void {
	ctx.ui.notify(plan.markdown, "info");
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
