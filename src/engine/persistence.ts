import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { assertWorkstreamState } from "./invariants.ts";
import { IDLE_STATE, WORKSTREAM_STATE_ENTRY, WorkstreamStateSchema, type WorkstreamState } from "./state.ts";

export function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

export function replayWorkstream(ctx: ExtensionContext): WorkstreamState {
	let restored: WorkstreamState = IDLE_STATE;
	for (const entry of ctx.sessionManager.getBranch() as Iterable<{
		type?: string;
		customType?: string;
		data?: unknown;
	}>) {
		if (entry.type !== "custom" || entry.customType !== WORKSTREAM_STATE_ENTRY) continue;
		if (!Value.Check(WorkstreamStateSchema, entry.data)) continue;
		restored = structuredClone(entry.data);
	}
	assertWorkstreamState(restored);
	return restored;
}

export class WorkstreamStore {
	readonly #sessions = new Map<string, WorkstreamState>();

	hydrate(ctx: ExtensionContext): WorkstreamState {
		const state = replayWorkstream(ctx);
		this.#sessions.set(sessionId(ctx), state);
		return state;
	}

	read(ctx: ExtensionContext): WorkstreamState {
		return this.#sessions.get(sessionId(ctx)) ?? IDLE_STATE;
	}

	commit(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkstreamState): void {
		assertWorkstreamState(state);
		this.#sessions.set(sessionId(ctx), state);
		pi.appendEntry(WORKSTREAM_STATE_ENTRY, structuredClone(state));
	}

	evict(ctx: ExtensionContext): void {
		this.#sessions.delete(sessionId(ctx));
	}
}
