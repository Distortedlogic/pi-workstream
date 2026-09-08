import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkstreamEffect } from "./effects.ts";
import type { WorkstreamEvent } from "./events.ts";
import { ERR_BATCH_CHANGED, ERR_PLAN_MISMATCH, assertWorkstreamState, sameBitmap } from "./invariants.ts";
import { WorkstreamStore, sessionId } from "./persistence.ts";
import { reduceWorkstream } from "./reducer.ts";
import type { WorkstreamState } from "./state.ts";
import type { PlanDocument } from "../plan/model.ts";
import { snapshotBatch } from "../plan/model.ts";
import { batchById, firstIncompleteBatch, nextIncompleteBatch } from "../plan/selectors.ts";
import { findPlanById, loadPlan, setTaskChecked, writeCanonicalPlan } from "../plan/store.ts";
import { appendBatchStart, appendCompression, navigateToBatchStart } from "../session/mutation.ts";
import { prepareCompression, restoreCompressionSource } from "../session/range.ts";
import { taskPrompt } from "../session/task-prompt.ts";
import { formatWorkstream } from "../ui/format.ts";
import { renderOverlay } from "../ui/overlay.ts";
import { reviewCompressionSummary } from "../ui/review.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function commandContext(ctx: ExtensionContext): ExtensionCommandContext {
	if (typeof (ctx as Partial<ExtensionCommandContext>).navigateTree !== "function") {
		throw new Error("This workstream operation requires a command-capable Pi context.");
	}
	return ctx as ExtensionCommandContext;
}

export class WorkstreamRuntime {
	readonly #store = new WorkstreamStore();
	readonly #plans = new Map<string, PlanDocument>();
	readonly #compressionSources = new Map<string, string>();

	constructor(readonly pi: ExtensionAPI) {}

	registerLifecycle(): void {
		this.pi.on("session_start", async (_event, ctx) => {
			await this.hydrate(ctx);
		});
		this.pi.on("session_tree", async (_event, ctx) => {
			await this.hydrate(ctx);
		});
		this.pi.on("session_shutdown", async (_event, ctx) => {
			this.#plans.delete(sessionId(ctx));
			this.#store.evict(ctx);
		});
	}

	state(ctx: ExtensionContext): WorkstreamState {
		return this.#store.read(ctx);
	}

	plan(ctx: ExtensionContext): PlanDocument | undefined {
		return this.#plans.get(sessionId(ctx));
	}

	status(ctx: ExtensionContext): string[] {
		return formatWorkstream(this.state(ctx), this.plan(ctx));
	}

	async hydrate(ctx: ExtensionContext): Promise<void> {
		const state = this.#store.hydrate(ctx);
		if ("run" in state) {
			try {
				const plan = await findPlanById(this.planRoot(), state.run.planId);
				this.#plans.set(sessionId(ctx), plan);
			} catch (error) {
				await this.dispatch(ctx, {
					type: "operation_failed",
					code: "plan_binding_mismatch",
					message: errorMessage(error) || ERR_PLAN_MISMATCH,
				});
				return;
			}
		}
		if (state.phase === "dispatching" || state.phase === "revalidating" || state.phase === "applying") {
			await this.dispatch(ctx, {
				type: "operation_failed",
				code: "interrupted_transient_operation",
				message: "A transient workstream operation was interrupted and cannot be resumed.",
			});
			return;
		}
		renderOverlay(ctx, state, this.plan(ctx));
	}

	async savePlan(markdown: string): Promise<PlanDocument> {
		return writeCanonicalPlan(this.planRoot(), markdown);
	}

	async start(planPath: string, ctx: ExtensionContext): Promise<void> {
		const current = this.state(ctx);
		if (current.phase !== "idle" && current.phase !== "complete" && current.phase !== "failed") {
			throw new Error("A workstream run is already active.");
		}
		if (current.phase !== "idle") await this.dispatch(ctx, { type: "reset_requested" });
		const plan = await loadPlan(planPath);
		const root = `${this.planRoot()}/`;
		if (!plan.path.startsWith(root)) throw new Error(`Plans must be stored under ${this.planRoot()}.`);
		const batch = firstIncompleteBatch(plan);
		if (!batch) throw new Error("The selected plan has no incomplete batch.");
		this.#plans.set(sessionId(ctx), plan);
		const run = { runId: randomUUID(), planId: plan.planId };
		const snapshot = snapshotBatch(plan, batch);
		const batchStartEntryId = appendBatchStart(this.pi, ctx, run, snapshot);
		await this.dispatch(ctx, { type: "run_started", run, batch: snapshot, batchStartEntryId });
	}

	async completeCurrentTask(ctx: ExtensionContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase !== "executing" && state.phase !== "pausing") {
			throw new Error("There is no active workstream task to complete.");
		}
		const plan = await this.requirePlan(ctx, state.run.planId);
		const freshPlan = await setTaskChecked(plan.path, state.batch.batchId, state.currentTaskIndex, true);
		this.#plans.set(sessionId(ctx), freshPlan);
		const freshBatch = batchById(freshPlan, state.batch.batchId);
		if (!freshBatch) throw new Error(ERR_PLAN_MISMATCH);
		await this.dispatch(ctx, {
			type: "task_finished",
			taskIndex: state.currentTaskIndex,
			freshBatch: snapshotBatch(freshPlan, freshBatch),
		});
	}

	async pause(ctx: ExtensionContext, reason = "Paused by user."): Promise<void> {
		await this.dispatch(ctx, { type: "pause_requested", reason });
	}

	async resume(ctx: ExtensionContext): Promise<void> {
		await this.dispatch(ctx, { type: "resume_requested" });
	}

	async continueReview(ctx: ExtensionContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase === "preparing_review") {
			await this.runEffect(ctx, {
				type: "prepare_review",
				batch: state.batch,
				batchStartEntryId: state.batchStartEntryId,
				completedTaskIndex: state.completedTaskIndex,
				preCompletionBitmap: state.preCompletionBitmap,
			});
			const reviewing = this.state(ctx);
			if (reviewing.phase === "reviewing") {
				await this.runEffect(ctx, { type: "open_review", compression: reviewing.compression });
			}
			return;
		}
		if (state.phase === "reviewing") {
			await this.runEffect(ctx, { type: "open_review", compression: state.compression });
			return;
		}
		throw new Error("The workstream is not waiting for a compression review.");
	}

	async fail(ctx: ExtensionContext, message: string): Promise<void> {
		const state = this.state(ctx);
		if (state.phase !== "executing" && state.phase !== "pausing") {
			throw new Error("There is no active workstream task to fail.");
		}
		await this.dispatch(ctx, { type: "operation_failed", code: "task_failed", message });
	}

	async reset(ctx: ExtensionContext): Promise<void> {
		await this.dispatch(ctx, { type: "reset_requested" });
		this.#plans.delete(sessionId(ctx));
	}

	private planRoot(): string {
		return resolve(process.cwd(), ".pi", "plans");
	}

	private async requirePlan(ctx: ExtensionContext, planId: string): Promise<PlanDocument> {
		const cached = this.#plans.get(sessionId(ctx));
		if (cached?.planId === planId) return cached;
		const plan = await findPlanById(this.planRoot(), planId);
		this.#plans.set(sessionId(ctx), plan);
		return plan;
	}

	private async dispatch(ctx: ExtensionContext, event: WorkstreamEvent): Promise<void> {
		const reduction = reduceWorkstream(this.state(ctx), event);
		assertWorkstreamState(reduction.state);
		try {
			for (const effect of reduction.effects) await this.runEffect(ctx, effect);
		} catch (error) {
			if (event.type === "operation_failed") throw error;
			await this.dispatch(ctx, {
				type: "operation_failed",
				code: "effect_failed",
				message: errorMessage(error),
			});
		}
		renderOverlay(ctx, this.state(ctx), this.plan(ctx));
	}

	private async runEffect(ctx: ExtensionContext, effect: WorkstreamEffect): Promise<void> {
		switch (effect.type) {
			case "persist":
				this.#store.commit(this.pi, ctx, effect.state);
				return;
			case "notify":
				if (ctx.hasUI) ctx.ui.notify(effect.message, effect.level);
				return;
			case "dispatch_task": {
				const state = this.state(ctx);
				if (!("run" in state)) throw new Error(ERR_PLAN_MISMATCH);
				const plan = await this.requirePlan(ctx, state.run.planId);
				const batch = batchById(plan, effect.batch.batchId);
				const task = batch?.tasks[effect.taskIndex];
				if (!batch || !task || task.checked) throw new Error(ERR_PLAN_MISMATCH);
				const prompt = taskPrompt(batch, task);
				if (ctx.isIdle()) this.pi.sendUserMessage(prompt);
				else this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				await this.dispatch(ctx, { type: "task_delivered", taskIndex: effect.taskIndex });
				return;
			}
			case "prepare_review": {
				const prepared = prepareCompression(ctx, effect.batchStartEntryId);
				this.#compressionSources.set(prepared.checkpoint.operationId, prepared.serializedSource);
				await this.dispatch(ctx, { type: "review_ready", compression: prepared.checkpoint });
				return;
			}
			case "open_review": {
				const source =
					this.#compressionSources.get(effect.compression.operationId) ?? restoreCompressionSource(ctx, effect.compression);
				const approvedSummary = await reviewCompressionSummary(commandContext(ctx), source);
				if (!approvedSummary) return;
				await this.dispatch(ctx, { type: "summary_saved", approvedSummary });
				return;
			}
			case "revalidate": {
				const state = this.state(ctx);
				if (!("run" in state)) throw new Error(ERR_PLAN_MISMATCH);
				const plan = await findPlanById(this.planRoot(), state.run.planId);
				this.#plans.set(sessionId(ctx), plan);
				const batch = batchById(plan, effect.acceptedBatch.batchId);
				if (!batch) throw new Error(ERR_PLAN_MISMATCH);
				const freshBatch = snapshotBatch(plan, batch);
				const freshPreCompletionBitmap = [...freshBatch.checkboxBitmap];
				freshPreCompletionBitmap[effect.completedTaskIndex] = false;
				if (!sameBitmap(freshPreCompletionBitmap, effect.preCompletionBitmap)) throw new Error(ERR_BATCH_CHANGED);
				await this.dispatch(ctx, {
					type: "revalidation_succeeded",
					freshBatch,
					freshPreCompletionBitmap,
					approvedSummary: effect.approvedSummary,
				});
				return;
			}
			case "apply_compression": {
				const state = this.state(ctx);
				if (state.phase !== "applying") throw new Error("The workstream is not ready to apply compression.");
				await navigateToBatchStart(commandContext(ctx), state.batchStartEntryId, effect.compression);
				this.#store.commit(this.pi, ctx, state);
				appendCompression(this.pi, state.run, state.batch, effect.compression, effect.approvedSummary);
				this.#compressionSources.delete(effect.compression.operationId);
				const plan = await this.requirePlan(ctx, state.run.planId);
				const nextBatch = nextIncompleteBatch(plan, state.batch.batchId);
				if (!nextBatch) {
					await this.dispatch(ctx, { type: "compression_applied" });
					return;
				}
				const snapshot = snapshotBatch(plan, nextBatch);
				const nextBatchStartEntryId = appendBatchStart(this.pi, ctx, state.run, snapshot);
				await this.dispatch(ctx, { type: "compression_applied", nextBatch: snapshot, nextBatchStartEntryId });
				return;
			}
		}
	}
}
