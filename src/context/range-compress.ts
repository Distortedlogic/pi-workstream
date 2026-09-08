import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import {
	CTREE_RANGE_COMPACT,
	CTREE_RANGE_TAIL,
	type CtreeRangeCompactData,
	type RangePlan,
	estimateTextTokens,
	fmtTokens,
	planRange,
	rangeCandidates,
	renderRangeTail,
	resolveRangeEndpoint,
	serializeEntry,
} from "@pi-context-tree/core";
import { type CmdCtxLike, type Deps, type PiLike, leafIdOf, modelKey } from "./adapter.ts";
import { refreshAmbient } from "./ambient.ts";
import { draftRangeSummary } from "./draft.ts";
import { deriveState } from "./state.ts";

type RangePhase = "start" | "end";
type RangeCompressionStage = "Drafting summary" | "Checking selected range" | "Applying compression";
type RangeCompressionProgress = (stage: RangeCompressionStage) => void;
type NativeTree = ReturnType<CmdCtxLike["sessionManager"]["getTree"]>;
type NativeTreeNode = NativeTree[number];

function pruneNativeTree(tree: NativeTree, allowedEntryIds: ReadonlySet<string>): NativeTree {
	const pruneNode = (node: NativeTreeNode): NativeTreeNode[] => {
		const children = node.children.flatMap(pruneNode);
		return allowedEntryIds.has(node.entry.id) ? [{ ...node, children }] : children;
	};
	return tree.flatMap(pruneNode);
}

export async function selectNativeEntry(
	ctx: CmdCtxLike,
	phase: RangePhase,
	initialSelectedId: string,
	allowedEntryIds: ReadonlySet<string>,
): Promise<string | undefined> {
	ctx.ui.notify(
		phase === "start" ? "Select the first entry of the range" : "Select the last entry of the range",
		"info",
	);
	if (!ctx.ui.custom) {
		ctx.ui.notify("The native tree selector is not available in this mode.", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>(
		(
			tui: { terminal: { rows: number } },
			_theme: unknown,
			_keybindings: unknown,
			done: (entryId: string | undefined) => void,
		) =>
			new TreeSelectorComponent(
				pruneNativeTree(ctx.sessionManager.getTree(), allowedEntryIds),
				ctx.sessionManager.getLeafId(),
				tui.terminal.rows,
				(entryId) => done(entryId),
				() => done(undefined),
				undefined,
				initialSelectedId,
				"default",
			),
	);
}

export function buildRangeCompactData(
	plan: RangePlan,
	approvedSummary: string,
	summaryModel: string,
): CtreeRangeCompactData {
	const summaryEstTokens = estimateTextTokens(approvedSummary);
	return {
		v: 1,
		sourceLeafId: plan.sourceLeafId,
		anchorId: plan.anchorId,
		startEntryId: plan.startEntryId,
		endEntryId: plan.endEntryId,
		selectedEntryIds: [...plan.selectedEntryIds],
		selectedEstTokens: plan.selectedEstTokens,
		summaryEstTokens,
		reclaimedEstTokens: plan.selectedEstTokens - summaryEstTokens,
		summaryModel,
		sourceSha8: plan.sourceSha8,
	};
}

/** Apply a generated range summary. The session is revalidated before every write. */
export async function applyRangeCompressionPlan(
	pi: PiLike,
	ctx: CmdCtxLike,
	initialPlan: RangePlan,
	summaryModel: string,
	instructions: string | undefined,
	deps: Deps,
	progress?: RangeCompressionProgress,
): Promise<boolean> {
	progress?.("Drafting summary");
	if (!progress) ctx.ui.notify(`drafting range summary with ${summaryModel}…`, "info");
	let generatedSummary: string;
	try {
		generatedSummary = (await draftRangeSummary(deps.draft, ctx, initialPlan.selectedSerialized, instructions)).trim();
		if (!generatedSummary) throw new Error("model returned an empty range summary");
	} catch (error) {
		ctx.ui.notify(`range summary failed: ${(error as Error).message} (nothing written)`, "error");
		return false;
	}

	progress?.("Checking selected range");
	await ctx.waitForIdle();
	const freshState = deriveState(ctx);
	if (!freshState.leafId || freshState.leafId !== initialPlan.sourceLeafId) {
		ctx.ui.notify("session changed while drafting the summary — re-run /compress (nothing written)", "warning");
		return false;
	}

	let plan: RangePlan;
	try {
		plan = planRange(freshState.tree, initialPlan.sourceLeafId, initialPlan.startEntryId, initialPlan.endEntryId);
	} catch (error) {
		ctx.ui.notify(`selected range is no longer valid: ${(error as Error).message} (nothing written)`, "warning");
		return false;
	}
	const sameSelectedIds =
		plan.selectedEntryIds.length === initialPlan.selectedEntryIds.length &&
		plan.selectedEntryIds.every((id, index) => id === initialPlan.selectedEntryIds[index]);
	if (!sameSelectedIds || plan.sourceSha8 !== initialPlan.sourceSha8) {
		ctx.ui.notify("selected range changed during summary review — re-run /compress (nothing written)", "warning");
		return false;
	}

	const details = buildRangeCompactData(plan, generatedSummary, summaryModel);
	const rebuilt = renderRangeTail(plan, generatedSummary);

	progress?.("Applying compression");
	if (leafIdOf(ctx) !== plan.sourceLeafId) {
		ctx.ui.notify("session changed before range compression was applied — nothing written", "warning");
		return false;
	}
	const navigation = await ctx.navigateTree(plan.anchorId, { summarize: false });
	if (navigation.cancelled) {
		ctx.ui.notify("range compression cancelled during navigation — nothing written", "warning");
		return false;
	}

	pi.sendMessage(
		{
			customType: CTREE_RANGE_TAIL,
			content: rebuilt,
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
	pi.appendEntry(CTREE_RANGE_COMPACT, details);
	refreshAmbient(pi, ctx);
	ctx.ui.notify(
		`compressed range: selected ~${fmtTokens(plan.selectedEstTokens)} · summary ~${fmtTokens(details.summaryEstTokens)} · reclaimed ~${fmtTokens(details.reclaimedEstTokens)} tokens · originals kept at ${plan.sourceLeafId}`,
		"info",
	);
	return true;
}

/** Keep compression blocking until the complete operation reports success or failure. */
export async function runBlockingRangeCompression(
	pi: PiLike,
	ctx: CmdCtxLike,
	plan: RangePlan,
	instructions: string | undefined,
	deps: Deps,
): Promise<boolean> {
	if (leafIdOf(ctx) !== plan.sourceLeafId) {
		ctx.ui.notify("session changed while the range selector was open — re-run /compress (nothing written)", "warning");
		return false;
	}
	const summaryModel = modelKey(ctx.model);
	if (!summaryModel) {
		ctx.ui.notify("no current model is available for the range summary — nothing written", "error");
		return false;
	}
	if (!ctx.ui.custom) return applyRangeCompressionPlan(pi, ctx, plan, summaryModel, instructions, deps);

	const result = await ctx.ui.custom<boolean>(
		(tui, theme, _keybindings, done) => {
			const rangeDetails = `summary model ${summaryModel} · ${plan.selectedEntryIds.length} selected entries · ~${fmtTokens(plan.selectedEstTokens)} source tokens`;
			const loader = Object.assign(
				new Loader(
					tui,
					(text) => theme.fg("accent", text),
					(text) => theme.fg("muted", text),
					`Preparing compression · ${rangeDetails}`,
				),
				{
					focused: true,
					// Pi handles global interrupts before this local input sink.
					handleInput: (_data: string): void => {},
				},
			);
			const finish = (success: boolean): void => {
				try {
					loader.stop();
				} finally {
					done(success);
				}
			};
			void Promise.resolve()
				.then(() =>
					applyRangeCompressionPlan(pi, ctx, plan, summaryModel, instructions, deps, (stage) => {
						loader.setMessage(`${stage} · ${rangeDetails}`);
					}),
				)
				.then(finish, (error: unknown) => {
					try {
						ctx.ui.notify(`range compression failed: ${(error as Error).message} (nothing else written)`, "error");
					} finally {
						finish(false);
					}
				});
			return loader;
		},
		{ overlay: false },
	);
	return result ?? false;
}

export async function rangeCompressHandler(pi: PiLike, ctx: CmdCtxLike, args: string, deps: Deps): Promise<void> {
	const instructions = args.trim() || undefined;
	await ctx.waitForIdle();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	const state = deriveState(ctx);
	if (!sourceLeafId || !state.tree.get(sourceLeafId)) {
		ctx.ui.notify("empty session — nothing to compress", "warning");
		return;
	}

	const candidates = rangeCandidates(state.tree, sourceLeafId);
	const allowedEntryIds = new Set(candidates.flatMap((candidate) => candidate.entryIds));
	const lastCandidate = candidates.at(-1);
	if (!lastCandidate) {
		ctx.ui.notify("no active context entries are available to compress", "warning");
		return;
	}
	let firstEntryId = "";
	let firstInitialId = allowedEntryIds.has(sourceLeafId) ? sourceLeafId : lastCandidate.endEntryId;
	while (!firstEntryId) {
		const selectedEntryId = await selectNativeEntry(ctx, "start", firstInitialId, allowedEntryIds);
		if (selectedEntryId === undefined) return;
		const endpoint = resolveRangeEndpoint(candidates, selectedEntryId, "start");
		if (!endpoint.ok) {
			ctx.ui.notify(`Invalid range start: ${endpoint.reason}. Select another entry.`, "warning");
			firstInitialId = selectedEntryId;
			continue;
		}
		firstEntryId = endpoint.entryId;
	}

	let secondInitialId = firstEntryId;
	while (true) {
		const selectedEntryId = await selectNativeEntry(ctx, "end", secondInitialId, allowedEntryIds);
		if (selectedEntryId === undefined) return;
		const endpoint = resolveRangeEndpoint(candidates, selectedEntryId, "end");
		if (!endpoint.ok) {
			ctx.ui.notify(`Invalid range end: ${endpoint.reason}. Select another entry.`, "warning");
			secondInitialId = selectedEntryId;
			continue;
		}

		let plan: RangePlan;
		try {
			plan = planRange(state.tree, sourceLeafId, firstEntryId, endpoint.entryId);
		} catch (error) {
			ctx.ui.notify(`Invalid range: ${(error as Error).message}. Select another last entry.`, "warning");
			secondInitialId = selectedEntryId;
			continue;
		}

		const startEntry = state.tree.get(plan.startEntryId);
		const endEntry = state.tree.get(plan.endEntryId);
		const startLabel = startEntry
			? (serializeEntry(startEntry)?.split("\n", 1)[0] ?? startEntry.type)
			: plan.startEntryId;
		const endLabel = endEntry ? (serializeEntry(endEntry)?.split("\n", 1)[0] ?? endEntry.type) : plan.endEntryId;
		const confirmed = await ctx.ui.confirm(
			"Compress selected range",
			[
				`Start: ${startLabel}`,
				`End: ${endLabel}`,
				`${plan.selectedEntryIds.length} entries · ~${fmtTokens(plan.selectedEstTokens)} tokens`,
				"The generated summary will be applied without review.",
				"Terminal input will pause until compression finishes.",
			].join("\n"),
		);
		if (!confirmed) return;

		await runBlockingRangeCompression(pi, ctx, plan, instructions, deps);
		return;
	}
}

export function registerRangeCompress(pi: PiLike, deps: Deps): void {
	pi.registerCommand("compress", {
		description: "pi-context-tree: select, summarize, and replace one active-context range",
		handler: (args, ctx) => rangeCompressHandler(pi, ctx, args, deps),
	});
}
