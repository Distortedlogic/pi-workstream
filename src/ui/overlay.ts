import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanDocument } from "../plan/model.ts";
import type { WorkstreamState } from "../engine/state.ts";
import { formatWorkstream } from "./format.ts";

export const WORKSTREAM_WIDGET = "pi-workstream";

export function renderOverlay(ctx: ExtensionContext, state: WorkstreamState, plan?: PlanDocument): void {
	if (!ctx.hasUI) return;
	if (state.phase === "idle") {
		ctx.ui.setWidget(WORKSTREAM_WIDGET, undefined);
		ctx.ui.setStatus(WORKSTREAM_WIDGET, undefined);
		return;
	}
	const lines = formatWorkstream(state, plan);
	ctx.ui.setWidget(WORKSTREAM_WIDGET, lines, { placement: "aboveEditor" });
	ctx.ui.setStatus(WORKSTREAM_WIDGET, lines[0]);
}
