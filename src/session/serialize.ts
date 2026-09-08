import type { SessionEntry } from "./types.ts";
import { textOfContent } from "./types.ts";

export function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "message" && entry.message) {
		const message = entry.message;
		switch (message.role) {
			case "user":
				return `user: ${textOfContent(message.content)}`;
			case "assistant":
				return `assistant: ${textOfContent(message.content)}`;
			case "toolResult":
				return `[${message.toolName ?? "tool"}]: ${textOfContent(message.content)}`;
			case "bashExecution":
				return message.excludeFromContext
					? undefined
					: `[bash $ ${message.command ?? ""}]: ${message.output ?? ""}`;
			case "branchSummary":
			case "compactionSummary":
				return `[${message.role}]: ${message.summary ?? ""}`;
			default:
				return textOfContent(message.content) || undefined;
		}
	}
	if (entry.type === "custom_message") return textOfContent(entry.content) || undefined;
	if (entry.type === "branch_summary" || entry.type === "compaction") return entry.summary;
	return undefined;
}

export function serializeEntries(entries: readonly SessionEntry[]): string {
	return entries.map(serializeEntry).filter((text): text is string => Boolean(text?.trim())).join("\n\n");
}
