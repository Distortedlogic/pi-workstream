import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SUMMARY_SYSTEM_PROMPT = [
	"Summarize one completed workstream batch.",
	"Return summary text only.",
	"Preserve requirements, decisions, file paths, commands, errors, validation state, unfinished work, and external effects.",
	"Do not invent results or remove uncertainty.",
].join("\n");

export async function reviewCompressionSummary(
	ctx: ExtensionCommandContext,
	serializedSource: string,
): Promise<string | undefined> {
	if (!ctx.hasUI || !ctx.model) throw new Error("Compression review requires an interactive session and a model.");
	const response = await ctx.modelRegistry.complete(ctx.model, {
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: serializedSource }],
				timestamp: Date.now(),
			},
		],
	});
	const draft = response.content
		.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!draft) throw new Error("The summary model returned no text.");
	const approved = await ctx.ui.editor("Review completed batch summary", draft);
	return approved?.trim() || undefined;
}
