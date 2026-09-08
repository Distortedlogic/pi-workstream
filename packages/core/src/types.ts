import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Pi session-format types (verified against earendil-works/pi-mono@0.84.3
 * docs/session-format.md and src/core/session-manager.ts) plus ctree's own
 * custom-entry payloads. Parsing is permissive: unknown entry/message shapes
 * are preserved, never dropped silently.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type UserContent = string | (TextContent | ImageContent)[];

// ---------------------------------------------------------------------------
// Agent messages (subset of fields we consume; extra fields pass through)
// ---------------------------------------------------------------------------

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface UserMessage {
	role: "user";
	content: UserContent;
	timestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	provider?: string;
	model?: string;
	usage?: Usage;
	stopReason?: string;
	timestamp?: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode?: number | null;
	cancelled?: boolean;
	truncated?: boolean;
	excludeFromContext?: boolean;
	timestamp?: number;
}

export interface CustomRoleMessage {
	role: "custom";
	customType: string;
	content: UserContent;
	display: boolean;
	details?: unknown;
	timestamp?: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp?: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp?: number;
}

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomRoleMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage;

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: unknown;
	fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: UserContent;
	display: boolean;
	details?: unknown;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/** Entry types this version does not understand are preserved, not dropped. */
export interface UnknownEntry extends SessionEntryBase {
	type: string;
	[key: string]: unknown;
}

export type SessionEntry =
	| MessageEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| UnknownEntry;

export const KNOWN_ENTRY_TYPES = new Set([
	"message",
	"model_change",
	"thinking_level_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

// ---------------------------------------------------------------------------
// ctree custom-entry payloads (schema-versioned, append-only)
// ---------------------------------------------------------------------------

export const CTREE_FORK = "ctree/fork";
export const CTREE_CLOSE = "ctree/close";
export const CTREE_DECISION = "ctree/decision";
export const CTREE_CROP = "ctree/crop";
export const CTREE_CROP_TAIL = "ctree/crop-tail";
export const CTREE_RANGE_COMPACT = "ctree/range-compact";
export const CTREE_RANGE_TAIL = "ctree/range-tail";

export type CtreeCloseStatus = "squashed" | "rejected" | "discarded";

export interface CtreeForkData {
	v: 1;
	name: string;
	parentEntryId: string | null;
	trunkModel?: string;
	branchModel?: string;
	createdAt: number;
	status: "open";
}

export interface CtreeCloseData {
	v: 1;
	forkEntryId: string;
	status: CtreeCloseStatus;
	decisionEntryId?: string;
	note?: string;
	/** the leaf at the moment of merge (the branch tip) — /undo navigates back here to re-open the branch */
	prevLeafId?: string;
}

export interface CtreeCropStub {
	entryId: string;
	tool: string;
	arg?: string;
	estTokens: number;
	sha8: string;
}

/** A whole Q&A turn removed from context (question + its answers, dropped together). */
export interface CtreeCropDrop {
	/** the opening user message id */
	userId: string;
	/** every entry id removed with the turn */
	entryIds: string[];
	/** first line of the question (display) */
	label: string;
	estTokens: number;
	/** hash of the removed bodies — recoverability proof */
	sha8: string;
}

export interface CtreeCropData {
	v: 1;
	sourceLeafId: string;
	stubbed: CtreeCropStub[];
	/** present only when whole turns were removed (not just tool results stubbed) */
	dropped?: CtreeCropDrop[];
}

export interface CtreeDecisionDetails {
	v: 1;
	forkEntryId: string;
	branchName: string;
	siblings?: { name: string; reason: string }[];
}

/**
 * Append-only metadata shared by the ctree/range-compact marker and the
 * ctree/range-tail custom message. Unknown fields are allowed so a v1 reader
 * does not reject additive schema changes.
 */
export const CtreeRangeCompactDataSchema = Type.Object(
	{
		v: Type.Literal(1),
		sourceLeafId: Type.String(),
		anchorId: Type.String(),
		startEntryId: Type.String(),
		endEntryId: Type.String(),
		selectedEntryIds: Type.Array(Type.String()),
		selectedEstTokens: Type.Number(),
		summaryEstTokens: Type.Number(),
		reclaimedEstTokens: Type.Number(),
		summaryModel: Type.String(),
		/** First eight hexadecimal characters of SHA-256(serialized selected source). */
		sourceSha8: Type.String(),
	},
	{ additionalProperties: true },
);

export type CtreeRangeCompactData = Static<typeof CtreeRangeCompactDataSchema>;

/** The visible range-tail message repeats the marker metadata in details. */
export type CtreeRangeTailDetails = CtreeRangeCompactData;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isMessageEntry(e: SessionEntry): e is MessageEntry {
	return e.type === "message" && typeof (e as MessageEntry).message === "object";
}

export function isCustomEntry(e: SessionEntry): e is CustomEntry {
	return e.type === "custom";
}

export function isCustomMessageEntry(e: SessionEntry): e is CustomMessageEntry {
	return e.type === "custom_message";
}

export function isCompactionEntry(e: SessionEntry): e is CompactionEntry {
	return e.type === "compaction";
}

export function isBranchSummaryEntry(e: SessionEntry): e is BranchSummaryEntry {
	return e.type === "branch_summary";
}

/** Recognize the operation marker without rejecting unknown schema versions. */
export function isCtreeRangeCompactEntry(e: SessionEntry): e is CustomEntry {
	return isCustomEntry(e) && e.customType === CTREE_RANGE_COMPACT;
}

/** Recognize the visible range-tail message without rejecting unknown schema versions. */
export function isCtreeRangeTailEntry(e: SessionEntry): e is CustomMessageEntry {
	return isCustomMessageEntry(e) && e.customType === CTREE_RANGE_TAIL;
}

/** Known v1 data for a marker; later versions remain preserved on the entry. */
export function ctreeRangeCompactData(e: SessionEntry): CtreeRangeCompactData | undefined {
	if (!isCtreeRangeCompactEntry(e)) return undefined;
	return Value.Check(CtreeRangeCompactDataSchema, e.data) ? e.data : undefined;
}

/** Known v1 details for a visible tail; later versions remain preserved on the entry. */
export function ctreeRangeTailDetails(e: SessionEntry): CtreeRangeTailDetails | undefined {
	if (!isCtreeRangeTailEntry(e)) return undefined;
	return Value.Check(CtreeRangeCompactDataSchema, e.details) ? e.details : undefined;
}

export function ctreeForkData(e: SessionEntry): CtreeForkData | undefined {
	if (!isCustomEntry(e) || e.customType !== CTREE_FORK) return undefined;
	const d = e.data as CtreeForkData | undefined;
	return d && d.v === 1 && typeof d.name === "string" ? d : undefined;
}

export function ctreeCloseData(e: SessionEntry): CtreeCloseData | undefined {
	if (!isCustomEntry(e) || e.customType !== CTREE_CLOSE) return undefined;
	const d = e.data as CtreeCloseData | undefined;
	return d && d.v === 1 && typeof d.forkEntryId === "string" ? d : undefined;
}
