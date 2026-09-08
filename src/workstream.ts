import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type Batch,
	type BatchSnapshot,
	ERR_PLAN_BINDING,
	PLAN_ROOT,
	type Plan,
	batchById,
	checkTask,
	findPlan,
	firstIncompleteBatch,
	loadPlan,
	nextIncompleteBatch,
	sameBitmap,
	sameSnapshot,
	savePlan,
	snapshot,
} from "./plan.ts";
import {
	STATE_ENTRY,
	appendBatchStart,
	appendCompression,
	compressionSource,
	hasCompression,
	navigateToBatchStart,
	prepareCompression,
} from "./session.ts";
import { render, reviewSummary, status } from "./ui.ts";

const exact = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const batch = Type.Object(
	{
		planId: hash,
		batchId: hash,
		structuralRevision: hash,
		fileRevision: hash,
		bitmap: Type.Array(Type.Boolean()),
	},
	exact,
);
const active = {
	v: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	planId: hash,
	batch,
	batchStartEntryId: Type.String({ minLength: 1 }),
};

export const WorkstreamStateSchema = Type.Union([
	Type.Object({ v: Type.Literal(1), phase: Type.Literal("idle") }, exact),
	Type.Object(
		{
			...active,
			phase: Type.Literal("running"),
			taskIndex: Type.Integer({ minimum: 0 }),
			pauseAfterTask: Type.Boolean(),
		},
		exact,
	),
	Type.Object(
		{
			...active,
			phase: Type.Literal("paused"),
			nextTaskIndex: Type.Integer({ minimum: 0 }),
		},
		exact,
	),
	Type.Object(
		{
			...active,
			phase: Type.Literal("review"),
			completedTaskIndex: Type.Integer({ minimum: 0 }),
			preCompletionBitmap: Type.Array(Type.Boolean()),
		},
		exact,
	),
	Type.Object({ v: Type.Literal(1), phase: Type.Literal("failed"), code: Type.String() }, exact),
	Type.Object({ v: Type.Literal(1), phase: Type.Literal("complete"), runId: Type.String(), planId: hash }, exact),
]);

export type WorkstreamState = Static<typeof WorkstreamStateSchema>;
const IDLE: WorkstreamState = { v: 1, phase: "idle" };
const ToolSchema = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("complete_task"), Type.Literal("fail_task")]),
});

function sid(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

function taskCompletionIsExact(before: boolean[], after: boolean[], index: number): boolean {
	return (
		before.length === after.length &&
		before[index] === false &&
		after[index] === true &&
		before.every((checked, taskIndex) => taskIndex === index || checked === after[taskIndex])
	);
}

class Workstream {
	readonly #states = new Map<string, WorkstreamState>();
	readonly #plans = new Map<string, Plan>();
	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.pi.on("session_start", async (_event, ctx) => this.hydrate(ctx));
		this.pi.on("session_tree", async (_event, ctx) => this.hydrate(ctx));
		this.pi.on("session_shutdown", async (_event, ctx) => {
			this.#states.delete(sid(ctx));
			this.#plans.delete(sid(ctx));
		});

		this.pi.registerCommand("workstream", {
			description: "Run and control one plan-bound workstream",
			handler: async (input, ctx) => {
				const [action = "status", ...rest] = input.trim().split(/\s+/);
				const value = rest.join(" ");
				try {
					switch (action.toLowerCase()) {
						case "plan": {
							const markdown = await ctx.ui.editor(
								"Create or refine a workstream plan",
								"# Plan title\n\n## Batch 1\n\n- [ ] First task\n",
							);
							if (markdown?.trim()) ctx.ui.notify(`Saved ${(await savePlan(markdown)).path}`, "info");
							return;
						}
						case "run":
							if (!value) throw new Error("Usage: /workstream run <plan-path>");
							await this.start(ctx, value);
							break;
						case "pause":
							this.pause(ctx);
							break;
						case "resume":
							await this.resume(ctx);
							break;
						case "review":
							await this.review(ctx);
							break;
						case "reset":
							this.set(ctx, IDLE);
							this.#plans.delete(sid(ctx));
							break;
						case "status":
							break;
						default:
							throw new Error("Usage: /workstream <plan|run|status|pause|resume|review|reset>");
					}
					ctx.ui.notify(status(this.state(ctx), this.#plans.get(sid(ctx))), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		this.pi.registerTool({
			name: "workstream",
			label: "Workstream",
			description: "Read or finish the one active plan-bound workstream task.",
			promptSnippet: "Complete only the active workstream task before advancing.",
			promptGuidelines: [
				"Use complete_task only after the active task is fully complete.",
				"Use fail_task when the active task cannot be completed.",
				"Do not select another task. Workstream controls task order.",
			],
			parameters: ToolSchema,
			execute: async (_id, params, _signal, _update, ctx) => {
				if (params.action === "complete_task") await this.completeTask(ctx);
				if (params.action === "fail_task") this.set(ctx, { v: 1, phase: "failed", code: "task_failed" });
				const state = this.state(ctx);
				return {
					content: [{ type: "text", text: status(state, this.#plans.get(sid(ctx))) }],
					details: {
						phase: state.phase,
						...("planId" in state ? { planId: state.planId } : {}),
						...("batch" in state ? { batchId: state.batch.batchId } : {}),
					},
				};
			},
		});
	}

	private state(ctx: ExtensionContext): WorkstreamState {
		return this.#states.get(sid(ctx)) ?? IDLE;
	}

	private set(ctx: ExtensionContext, state: WorkstreamState): void {
		if (!Value.Check(WorkstreamStateSchema, state)) throw new Error("The workstream state is invalid.");
		if ("batch" in state && state.batch.planId !== state.planId) throw new Error("The workstream state is invalid.");
		this.#states.set(sid(ctx), state);
		this.pi.appendEntry(STATE_ENTRY, structuredClone(state));
		render(ctx, state, this.#plans.get(sid(ctx)));
	}

	private replay(ctx: ExtensionContext): WorkstreamState {
		let state = IDLE;
		for (const entry of ctx.sessionManager.getBranch() as Iterable<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>) {
			if (
				entry.type === "custom" &&
				entry.customType === STATE_ENTRY &&
				Value.Check(WorkstreamStateSchema, entry.data)
			) {
				state = structuredClone(entry.data);
			}
		}
		return state;
	}

	private async hydrate(ctx: ExtensionContext): Promise<void> {
		const state = this.replay(ctx);
		this.#states.set(sid(ctx), state);
		if (state.phase === "running" || state.phase === "paused" || state.phase === "review") {
			try {
				const plan = await findPlan(state.planId);
				this.#plans.set(sid(ctx), plan);
				if (state.phase === "review" && hasCompression(ctx, state.runId, state.batch.batchId)) {
					await this.advance(ctx, state, plan);
					return;
				}
			} catch {
				this.set(ctx, { v: 1, phase: "failed", code: "plan_binding_mismatch" });
				return;
			}
		}
		render(ctx, state, this.#plans.get(sid(ctx)));
	}

	private async plan(ctx: ExtensionContext, planId: string): Promise<Plan> {
		const cached = this.#plans.get(sid(ctx));
		if (cached?.id === planId) return cached;
		const plan = await findPlan(planId);
		this.#plans.set(sid(ctx), plan);
		return plan;
	}

	private async start(ctx: ExtensionContext, path: string): Promise<void> {
		if (
			this.state(ctx).phase !== "idle" &&
			this.state(ctx).phase !== "failed" &&
			this.state(ctx).phase !== "complete"
		) {
			throw new Error("A workstream run is already active.");
		}
		const plan = await loadPlan(path);
		const location = relative(PLAN_ROOT, plan.path);
		if (location.startsWith("..") || isAbsolute(location)) throw new Error(`Plans must be stored under ${PLAN_ROOT}.`);
		const batch = firstIncompleteBatch(plan);
		if (!batch) throw new Error("The selected plan has no incomplete batch.");
		const runId = randomUUID();
		const batchState = snapshot(plan, batch);
		this.#plans.set(sid(ctx), plan);
		this.deliver(
			ctx,
			runId,
			plan,
			batch,
			batchState,
			batch.bitmap.indexOf(false),
			appendBatchStart(this.pi, ctx, runId, batchState),
		);
	}

	private deliver(
		ctx: ExtensionContext,
		runId: string,
		plan: Plan,
		batch: Batch,
		batchState: BatchSnapshot,
		taskIndex: number,
		batchStartEntryId: string,
	): void {
		const task = batch.tasks[taskIndex];
		if (!task || task.checked) throw new Error(ERR_PLAN_BINDING);
		this.set(ctx, {
			v: 1,
			phase: "running",
			runId,
			planId: plan.id,
			batch: batchState,
			batchStartEntryId,
			taskIndex,
			pauseAfterTask: false,
		});
		const prompt = `[Workstream ${batch.index + 1}: ${batch.title}]\n[Task ${task.index + 1}/${batch.tasks.length}]\n\n${task.text}`;
		if (ctx.isIdle()) this.pi.sendUserMessage(prompt);
		else this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	private pause(ctx: ExtensionContext): void {
		const state = this.state(ctx);
		if (state.phase !== "running") throw new Error("There is no active task to pause after.");
		this.set(ctx, { ...state, pauseAfterTask: true });
	}

	private async resume(ctx: ExtensionContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase === "running" && state.pauseAfterTask) {
			this.set(ctx, { ...state, pauseAfterTask: false });
			return;
		}
		if (state.phase !== "paused") throw new Error("The workstream is not paused.");
		const plan = await this.plan(ctx, state.planId);
		const batch = batchById(plan, state.batch.batchId);
		if (!batch) throw new Error(ERR_PLAN_BINDING);
		this.deliver(ctx, state.runId, plan, batch, state.batch, state.nextTaskIndex, state.batchStartEntryId);
	}

	private async completeTask(ctx: ExtensionContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase !== "running") throw new Error("There is no active task to complete.");
		const plan = await this.plan(ctx, state.planId);
		const freshPlan = await checkTask(plan, state.batch.batchId, state.taskIndex);
		const freshBatch = batchById(freshPlan, state.batch.batchId);
		if (!freshBatch) throw new Error(ERR_PLAN_BINDING);
		const freshState = snapshot(freshPlan, freshBatch);
		if (
			state.batch.planId !== freshState.planId ||
			state.batch.batchId !== freshState.batchId ||
			state.batch.structuralRevision !== freshState.structuralRevision ||
			!taskCompletionIsExact(state.batch.bitmap, freshState.bitmap, state.taskIndex)
		) {
			this.set(ctx, { v: 1, phase: "failed", code: "batch_changed" });
			return;
		}
		this.#plans.set(sid(ctx), freshPlan);
		const nextTaskIndex = freshBatch.bitmap.indexOf(false);
		if (nextTaskIndex !== -1 && state.pauseAfterTask) {
			this.set(ctx, {
				v: 1,
				phase: "paused",
				runId: state.runId,
				planId: state.planId,
				batch: freshState,
				batchStartEntryId: state.batchStartEntryId,
				nextTaskIndex,
			});
			return;
		}
		if (nextTaskIndex !== -1) {
			this.deliver(ctx, state.runId, freshPlan, freshBatch, freshState, nextTaskIndex, state.batchStartEntryId);
			return;
		}
		this.set(ctx, {
			v: 1,
			phase: "review",
			runId: state.runId,
			planId: state.planId,
			batch: freshState,
			batchStartEntryId: state.batchStartEntryId,
			completedTaskIndex: state.taskIndex,
			preCompletionBitmap: state.batch.bitmap,
		});
	}

	private async review(ctx: ExtensionCommandContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase !== "review") throw new Error("No completed batch is waiting for review.");
		const compression = prepareCompression(ctx, state.batchStartEntryId);
		const summary = await reviewSummary(ctx, compressionSource(ctx, compression));
		if (!summary) return;
		const plan = await findPlan(state.planId);
		const batch = batchById(plan, state.batch.batchId);
		if (!batch) throw new Error(ERR_PLAN_BINDING);
		const freshState = snapshot(plan, batch);
		const preCompletion = [...freshState.bitmap];
		preCompletion[state.completedTaskIndex] = false;
		if (!sameSnapshot(state.batch, freshState) || !sameBitmap(state.preCompletionBitmap, preCompletion)) {
			throw new Error("The current plan batch changed before compression could be applied.");
		}
		compressionSource(ctx, compression);
		await navigateToBatchStart(ctx, state.batchStartEntryId, compression);
		this.set(ctx, state);
		appendCompression(this.pi, state.runId, state.batch, compression, summary);
		this.#plans.set(sid(ctx), plan);
		await this.advance(ctx, state, plan);
	}

	private async advance(
		ctx: ExtensionContext,
		state: Extract<WorkstreamState, { phase: "review" }>,
		plan: Plan,
	): Promise<void> {
		const next = nextIncompleteBatch(plan, state.batch.batchId);
		if (!next) {
			this.set(ctx, { v: 1, phase: "complete", runId: state.runId, planId: state.planId });
			return;
		}
		const nextState = snapshot(plan, next);
		const marker = appendBatchStart(this.pi, ctx, state.runId, nextState);
		this.deliver(ctx, state.runId, plan, next, nextState, next.bitmap.indexOf(false), marker);
	}
}

export default function piWorkstream(pi: ExtensionAPI): void {
	new Workstream(pi).register();
}
