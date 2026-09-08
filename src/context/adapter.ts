/**
 * Structural slice of pi's extension API — the ONLY pi-coupled surface
 * (TRD §1: session-adapter). Commands code against these interfaces; tests
 * provide fakes; src/index.ts binds the real ExtensionAPI (verified 0.84.3).
 */

import { basename } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@pi-context-tree/core";

export type ModelLike = Model<any>;

export type UiLike = Pick<
	ExtensionContext["ui"],
	"notify" | "select" | "confirm" | "input" | "editor" | "setStatus" | "setTitle"
> &
	Partial<Pick<ExtensionContext["ui"], "custom" | "setWidget">>;

export type SessionManagerLike = Pick<
	ExtensionContext["sessionManager"],
	"getEntries" | "getTree" | "getBranch" | "getEntry" | "getLeafId"
>;

export type ModelRegistryLike = Pick<ExtensionContext["modelRegistry"], "find" | "complete"> &
	Partial<Pick<ExtensionContext["modelRegistry"], "getAll">>;

export type CtxLike = Pick<ExtensionContext, "model"> &
	Partial<Pick<ExtensionContext, "getContextUsage">> & {
		ui: UiLike;
		sessionManager: SessionManagerLike;
		modelRegistry: ModelRegistryLike;
	};

/** Command-capable context (pi's ExtensionCommandContext). */
export type CmdCtxLike = CtxLike & Pick<ExtensionCommandContext, "waitForIdle" | "navigateTree">;

export type PiLike = Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "appendEntry" | "setLabel" | "setModel"> &
	Partial<Pick<ExtensionAPI, "registerShortcut" | "on" | "getSessionName" | "registerMessageRenderer">>;

/** Drafting dependency — real implementation calls the branch model via pi-ai. */
export type DraftFn = (ctx: CmdCtxLike, modelRef: string | undefined, system: string, user: string) => Promise<string>;

export interface Deps {
	draft: DraftFn;
}

// -- helpers -----------------------------------------------------------------

export function entriesOf(ctx: CtxLike): SessionEntry[] {
	return ctx.sessionManager.getEntries() as SessionEntry[];
}

export function leafIdOf(ctx: CtxLike): string | null {
	return ctx.sessionManager.getLeafId();
}

export function lastEntryId(ctx: CtxLike): string | null {
	const entries = entriesOf(ctx);
	return entries.length ? (entries[entries.length - 1]?.id ?? null) : null;
}

/** appendEntry returns void in pi — recover the new entry's id from the log. */
export function appendAndGetId(pi: PiLike, ctx: CtxLike, customType: string, data: unknown): string | null {
	pi.appendEntry(customType, data);
	return lastEntryId(ctx);
}

export function modelKey(m: ModelLike | undefined): string | undefined {
	return m ? `${m.provider}/${m.id}` : undefined;
}

/** Resolve "provider/id" or bare id (exact, then unique substring) to a Model. */
export function resolveModel(ctx: CtxLike, ref: string): ModelLike | undefined {
	if (ref.includes("/")) {
		const [provider, ...rest] = ref.split("/");
		return ctx.modelRegistry.find(provider ?? "", rest.join("/"));
	}
	const all = ctx.modelRegistry.getAll?.() ?? [];
	const exact = all.find((m) => m.id === ref);
	if (exact) return exact;
	const matches = all.filter((m) => m.id.includes(ref));
	return matches.length === 1 ? matches[0] : undefined;
}

export function projectName(): string {
	return basename(process.cwd());
}
