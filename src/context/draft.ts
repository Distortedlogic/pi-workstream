/** Decision-record drafting through Pi's public model registry. */

import { estimateTextTokens } from "@pi-context-tree/core";
import type { CmdCtxLike, DraftFn, ModelLike } from "./adapter.ts";
import { resolveModel } from "./adapter.ts";

export const DRAFT_SYSTEM_PROMPT = [
	"You write terse engineering decision records for a coding-agent session.",
	"Output ONLY the markdown record, no preamble. Target 1,000–2,000 tokens.",
	"Be specific: real file paths, real failure modes, real numbers from the transcript.",
].join("\n");

export const RANGE_COMPRESSION_SYSTEM_PROMPT = [
	"Summarize one user-selected range from a coding-agent session.",
	"Return summary text only. Do not add a preamble, analysis, or comments about summarizing.",
	"Preserve all information that later work can depend on:",
	"- the user's intent, requirements, and constraints",
	"- decisions, alternatives, and rejected approaches with their reasons",
	"- exact file paths, identifiers, symbols, versions, and important values",
	"- commands and important output needed to understand or repeat the work",
	"- errors, failed attempts, and their known causes",
	"- external side effects, including files, services, messages, and remote changes",
	"- validation state: what was tested, what passed, what failed, and what was not run",
	"- unfinished work, blockers, and the next concrete action",
	"Do not invent results or remove uncertainty. State unknown or unverified facts clearly.",
].join("\n");

export const realDraft: DraftFn = async (ctx, modelRef, system, user) => {
	const model: ModelLike | undefined = (modelRef ? resolveModel(ctx, modelRef) : undefined) ?? ctx.model;
	if (!model) throw new Error("no model available for drafting");
	const response = await ctx.modelRegistry.complete(model, {
		systemPrompt: system,
		messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
	});
	const text = (response.content as { type: string; text?: string }[])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n")
		.trim();
	if (!text) throw new Error("model returned an empty draft");
	return text;
};

export function draftUserPrompt(branchName: string, template: string, serialized: string, extra?: string): string {
	return [
		`Squash-merge the branch "${branchName}" into a decision record using EXACTLY this template:`,
		"",
		template,
		extra ? `Additional instructions from the user: ${extra}` : "",
		"",
		"Branch transcript (tool outputs truncated):",
		"---",
		serialized,
		"---",
	]
		.filter(Boolean)
		.join("\n");
}

/** Build the summary request with the complete selected source and no per-message truncation. */
export function rangeCompressionUserPrompt(selectedSerialized: string, instructions?: string): string {
	if (!selectedSerialized.trim()) throw new Error("the selected range has no serializable source text");
	return [
		"Summarize the complete selected session range below.",
		instructions?.trim() ? `Additional instructions from the user:\n${instructions.trim()}` : "",
		"<selected-session-range>",
		selectedSerialized,
		"</selected-session-range>",
	]
		.filter(Boolean)
		.join("\n\n");
}

function assertRangeSummaryFits(ctx: CmdCtxLike, userPrompt: string): void {
	if (!ctx.model) throw new Error("cannot check the selected range size because no current model is available");
	const contextWindow = ctx.model.contextWindow ?? ctx.getContextUsage?.()?.contextWindow;
	const modelRef = `${ctx.model.provider}/${ctx.model.id}`;
	if (!contextWindow || contextWindow <= 0) {
		throw new Error(
			`cannot check the selected range size because ${modelRef} does not report a context window; select a smaller range or choose a model with context metadata`,
		);
	}
	const inputTokens = estimateTextTokens(`${RANGE_COMPRESSION_SYSTEM_PROMPT}\n${userPrompt}`);
	const summaryOutputReserveTokens = Math.min(4096, ctx.model.maxTokens);
	const requiredTokens = inputTokens + summaryOutputReserveTokens;
	if (requiredTokens > contextWindow) {
		throw new Error(
			`selected range is too large for ${modelRef}: the prompt needs ~${inputTokens} input tokens plus ${summaryOutputReserveTokens} reserved output tokens, but the context window is ${contextWindow}; select a smaller range with /compress or switch the current model`,
		);
	}
}

/** Draft with the current model by leaving DraftFn's model reference undefined. */
export async function draftRangeSummary(
	draft: DraftFn,
	ctx: CmdCtxLike,
	selectedSerialized: string,
	instructions?: string,
): Promise<string> {
	const userPrompt = rangeCompressionUserPrompt(selectedSerialized, instructions);
	assertRangeSummaryFits(ctx, userPrompt);
	return draft(ctx, undefined, RANGE_COMPRESSION_SYSTEM_PROMPT, userPrompt);
}
