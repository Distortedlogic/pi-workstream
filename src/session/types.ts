export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type MessageContent = string | Array<TextContent | ImageContent | ToolCallContent | Record<string, unknown>>;

export interface SessionEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: {
		role?: string;
		content?: MessageContent;
		toolName?: string;
		command?: string;
		output?: string;
		summary?: string;
		excludeFromContext?: boolean;
	};
	customType?: string;
	data?: unknown;
	content?: MessageContent;
	summary?: string;
}

export function textOfContent(content: MessageContent | undefined): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.map((block) => {
			if (block.type === "text" && "text" in block) return String(block.text);
			if (block.type === "image") return "[image]";
			if (block.type === "toolCall" && "name" in block) {
				return `→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
