import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolCallEvent,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type Batch,
	type BatchSnapshot,
	ERR_MULTIPLE_PLANS,
	ERR_NO_PLAN,
	ERR_PLAN_BINDING,
	type Plan,
	Sha256Schema,
	batchById,
	completeBatch,
	findPlan,
	firstIncompleteBatch,
	incompletePlan,
	listPlans,
	loadPlan,
	planRoot,
	preparePlanWrite,
	sameBitmap,
	snapshot,
	tryParsePlan,
	validatePlanEdits,
} from "./plan.ts";
import {
	STATE_ENTRY,
	appendBatchStart,
	applyCompression,
	compressionOnBranch,
	prepareCompression,
	revalidateCompression,
} from "./session.ts";
import { render, reviewSummary, showPlan, status } from "./ui.ts";

const VERSION = 2;
const PLAN_WRITE_ENTRY = "pi-workstream/plan-write";
const exact = { additionalProperties: false } as const;
const PauseCodeSchema = Type.Union([
	Type.Literal("plan_binding_mismatch"),
	Type.Literal("stale_structure"),
	Type.Literal("stale_file"),
	Type.Literal("stale_bitmap"),
	Type.Literal("invalid_range"),
	Type.Literal("session_changed"),
	Type.Literal("summary_failed"),
	Type.Literal("completion_failed"),
]);

const activeFields = {
	v: Type.Literal(VERSION),
	runId: Type.String({ minLength: 1 }),
	planId: Sha256Schema,
	structuralRevision: Sha256Schema,
	fileRevision: Sha256Schema,
	batchId: Sha256Schema,
	batchOrdinal: Type.Integer({ minimum: 0 }),
	preCompletionBitmap: Type.Array(Type.Boolean()),
	preTaskAnchorId: Type.String({ minLength: 1 }),
	lastSettledEntryId: Type.Optional(Type.String({ minLength: 1 })),
	lastCompressionOperationId: Type.Optional(Type.String({ minLength: 1 })),
};

const WorkstreamStateSchema = Type.Union([
	Type.Object({ v: Type.Literal(VERSION), phase: Type.Literal("idle") }, exact),
	Type.Object({ ...activeFields, phase: Type.Literal("running") }, exact),
	Type.Object(
		{
			...activeFields,
			phase: Type.Literal("compressing"),
			lastSettledEntryId: Type.String({ minLength: 1 }),
			lastCompressionOperationId: Type.String({ minLength: 1 }),
		},
		exact,
	),
	Type.Object({ ...activeFields, phase: Type.Literal("paused"), code: PauseCodeSchema }, exact),
	Type.Object(
		{
			v: Type.Literal(VERSION),
			phase: Type.Literal("paused"),
			runId: Type.String({ minLength: 1 }),
			planId: Sha256Schema,
			code: Type.Literal("plan_binding_mismatch"),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(VERSION),
			phase: Type.Literal("complete"),
			runId: Type.String({ minLength: 1 }),
			planId: Sha256Schema,
		},
		exact,
	),
]);

export type WorkstreamState = Static<typeof WorkstreamStateSchema>;
export type PauseCode = Static<typeof PauseCodeSchema>;
type ActiveFields = Omit<Extract<WorkstreamState, { phase: "running" }>, "phase">;

const IDLE: WorkstreamState = { v: VERSION, phase: "idle" };
const QUEUED_RULE = [
	"Complete only this task batch.",
	"Do not plan or work on later batches.",
	"Finish all required work in this batch, then stop.",
].join(" ");

function sid(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

function isActive(state: WorkstreamState): state is Extract<WorkstreamState, { batchId: string }> {
	return "batchId" in state;
}

function isInside(root: string, path: string): boolean {
	const location = relative(root, path);
	return location !== "" && !location.startsWith("..") && !isAbsolute(location);
}

function stateSnapshot(state: Extract<WorkstreamState, { batchId: string }>): BatchSnapshot {
	return {
		planId: state.planId,
		batchId: state.batchId,
		structuralRevision: state.structuralRevision,
		fileRevision: state.fileRevision,
		bitmap: [...state.preCompletionBitmap],
	};
}

function activeState(
	phase: "running" | "compressing",
	runId: string,
	plan: Plan,
	batch: Batch,
	batchOrdinal: number,
	preTaskAnchorId: string,
	extra: Pick<ActiveFields, "lastSettledEntryId" | "lastCompressionOperationId"> = {},
): Extract<WorkstreamState, { phase: "running" | "compressing" }> {
	const current = snapshot(plan, batch);
	const fields: ActiveFields = {
		v: VERSION,
		runId,
		planId: current.planId,
		structuralRevision: current.structuralRevision,
		fileRevision: current.fileRevision,
		batchId: current.batchId,
		batchOrdinal,
		preCompletionBitmap: [...current.bitmap],
		preTaskAnchorId,
		...extra,
	};
	if (phase === "compressing") {
		const { lastSettledEntryId, lastCompressionOperationId } = fields;
		if (!lastSettledEntryId || !lastCompressionOperationId) {
			throw new Error("A compressing run requires settled and operation identities.");
		}
		return { ...fields, phase, lastSettledEntryId, lastCompressionOperationId };
	}
	return { ...fields, phase };
}

class Workstream {
	readonly #states = new Map<string, WorkstreamState>();
	readonly #plans = new Map<string, Plan>();
	readonly #commandContexts = new Map<string, ExtensionCommandContext>();
	readonly #pendingPlanWrites = new Map<string, string>();
	readonly #busy = new Set<string>();
	readonly #mutating = new Set<string>();

	constructor(readonly pi: ExtensionAPI) {}

	register(): void {
		this.pi.on("session_start", async (_event, ctx) => this.hydrate(ctx));
		this.pi.on("session_tree", async (_event, ctx) => {
			if (!this.#mutating.has(sid(ctx))) await this.hydrate(ctx);
		});
		this.pi.on("session_shutdown", async (_event, ctx) => {
			const id = sid(ctx);
			this.#states.delete(id);
			this.#plans.delete(id);
			this.#commandContexts.delete(id);
			this.#busy.delete(id);
			this.#mutating.delete(id);
		});
		this.pi.on("tool_call", async (event, ctx) => this.interceptPlanTool(event, ctx));
		this.pi.on("tool_result", async (event, ctx) => {
			const path = this.#pendingPlanWrites.get(event.toolCallId);
			if (!path) return;
			this.#pendingPlanWrites.delete(event.toolCallId);
			if (event.isError) return;
			try {
				const plan = await loadPlan(path);
				this.#plans.set(sid(ctx), plan);
				this.pi.appendEntry(PLAN_WRITE_ENTRY, { v: 1, planId: plan.id });
				render(ctx, this.state(ctx), plan);
			} catch {
				ctx.ui.notify("The written task plan is invalid.", "error");
			}
		});
		this.pi.on("agent_settled", async (_event, ctx) => this.onSettled(ctx));

		this.pi.registerCommand("todos", {
			description: "Show the disk-backed task plan",
			handler: async (_args, ctx) => {
				try {
					showPlan(ctx, await this.displayPlan(ctx));
				} catch (error) {
					ctx.ui.notify(this.message(error), "error");
				}
			},
		});

		this.pi.registerCommand("queue", {
			description: "Run the one incomplete disk-backed task plan",
			handler: async (args, ctx) => {
				if (args.trim() !== "run") {
					ctx.ui.notify("Usage: /queue run", "error");
					return;
				}
				try {
					await this.run(ctx);
				} catch (error) {
					ctx.ui.notify(this.message(error), "error");
				}
			},
		});
	}

	private state(ctx: ExtensionContext): WorkstreamState {
		return this.#states.get(sid(ctx)) ?? IDLE;
	}

	private set(ctx: ExtensionContext, state: WorkstreamState): void {
		if (!Value.Check(WorkstreamStateSchema, state)) throw new Error("The queue plan state is invalid.");
		this.#states.set(sid(ctx), structuredClone(state));
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
		if (state.phase === "idle") {
			try {
				const plans = await listPlans(planRoot(ctx.cwd));
				const incomplete = plans.filter((plan) => firstIncompleteBatch(plan));
				const plan = incomplete.length === 1 ? incomplete[0] : undefined;
				if (plan) this.#plans.set(sid(ctx), plan);
				render(ctx, state, plan);
			} catch {
				render(ctx, state);
			}
			return;
		}
		try {
			const plan = await findPlan(state.planId, planRoot(ctx.cwd));
			this.#plans.set(sid(ctx), plan);
			if (state.phase === "complete") {
				render(ctx, state, plan);
				return;
			}
			if (!isActive(state)) {
				render(ctx, state, plan);
				return;
			}
			const batch = batchById(plan, state.batchId);
			if (!batch) throw new Error(ERR_PLAN_BINDING);
			if (plan.structuralRevision !== state.structuralRevision) {
				this.pause(ctx, state, "stale_structure");
				return;
			}
			render(ctx, state, plan);
		} catch {
			this.set(ctx, {
				v: VERSION,
				phase: "paused",
				runId: state.runId,
				planId: state.planId,
				code: "plan_binding_mismatch",
			});
		}
	}

	private async interceptPlanTool(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		try {
			if (isToolCallEventType("write", event)) {
				const root = planRoot(ctx.cwd);
				const requestedPath = resolve(ctx.cwd, event.input.path);
				const parsed = tryParsePlan(event.input.content);
				if (!parsed) {
					if (isInside(root, requestedPath)) {
						return { block: true, reason: "Files under .pi/tasks must be valid canonical task plans." };
					}
					return;
				}
				if (isActive(this.state(ctx))) {
					return { block: true, reason: "A task plan cannot be rewritten during an active queue run." };
				}
				const plan = await preparePlanWrite(event.input.content, root);
				event.input.path = plan.path;
				this.#pendingPlanWrites.set(event.toolCallId, plan.path);
				return;
			}
			if (!isToolCallEventType("edit", event)) return;
			const root = planRoot(ctx.cwd);
			const requestedPath = resolve(ctx.cwd, event.input.path);
			if (!isInside(root, requestedPath)) return;
			if (isActive(this.state(ctx))) {
				return { block: true, reason: "A task plan cannot be edited during an active queue run." };
			}
			const plan = await loadPlan(requestedPath);
			if (resolve(root, plan.filename) !== requestedPath) {
				return { block: true, reason: "Task plan edits must target the canonical .pi/tasks path." };
			}
			await validatePlanEdits(requestedPath, event.input.edits);
			this.#pendingPlanWrites.set(event.toolCallId, requestedPath);
			return;
		} catch (error) {
			return { block: true, reason: this.message(error) };
		}
	}

	private async displayPlan(ctx: ExtensionContext): Promise<Plan> {
		const state = this.state(ctx);
		if (state.phase !== "idle") return findPlan(state.planId, planRoot(ctx.cwd));
		const plans = await listPlans(planRoot(ctx.cwd));
		const incomplete = plans.filter((plan) => firstIncompleteBatch(plan));
		if (incomplete.length === 0) throw new Error(ERR_NO_PLAN);
		if (incomplete.length !== 1) throw new Error(ERR_MULTIPLE_PLANS);
		return incomplete[0];
	}

	private async run(ctx: ExtensionCommandContext): Promise<void> {
		const id = sid(ctx);
		this.#commandContexts.set(id, ctx);
		if (this.#busy.has(id)) {
			ctx.ui.notify("The current batch transition is already running.", "warning");
			return;
		}
		const state = this.state(ctx);
		if (state.phase === "idle") {
			const plan = await incompletePlan(planRoot(ctx.cwd));
			if (this.hasPlanningWrite(ctx, plan.id)) {
				throw new Error("Start a new Pi session before /queue run so future task batches stay out of agent context.");
			}
			const batch = firstIncompleteBatch(plan);
			if (!batch) throw new Error(ERR_NO_PLAN);
			this.#plans.set(id, plan);
			this.dispatch(ctx, randomUUID(), plan, batch);
			return;
		}
		if (state.phase === "complete") {
			await findPlan(state.planId, planRoot(ctx.cwd));
			ctx.ui.notify(status(state), "info");
			return;
		}
		if (!isActive(state)) {
			const plan = await findPlan(state.planId, planRoot(ctx.cwd));
			const batch = firstIncompleteBatch(plan);
			if (!batch) {
				this.set(ctx, { v: VERSION, phase: "complete", runId: state.runId, planId: state.planId });
				return;
			}
			this.dispatch(ctx, state.runId, plan, batch);
			return;
		}
		await this.resume(ctx, state);
	}

	private async resume(
		ctx: ExtensionCommandContext,
		state: Extract<WorkstreamState, { batchId: string }>,
	): Promise<void> {
		const plan = await findPlan(state.planId, planRoot(ctx.cwd));
		const batch = batchById(plan, state.batchId);
		if (!batch) throw new Error(ERR_PLAN_BINDING);
		if (plan.structuralRevision !== state.structuralRevision) {
			this.pause(ctx, state, "stale_structure");
			return;
		}
		const applied = compressionOnBranch(ctx, state.runId, state.batchId);
		if (applied) {
			await this.finishApplied(ctx, state.runId, plan, batch, applied.preCompletionBitmap, applied.fileRevision);
			return;
		}
		const lastSettledEntryId = state.lastSettledEntryId ?? this.settledEnd(ctx, state.preTaskAnchorId);
		if (lastSettledEntryId) {
			await this.finishBatch(ctx, { ...state, phase: "running", lastSettledEntryId }, lastSettledEntryId);
			return;
		}
		if (state.phase === "paused") {
			this.dispatch(ctx, state.runId, plan, batch);
			return;
		}
		ctx.ui.notify("The current task batch is still running.", "info");
	}

	private dispatch(ctx: ExtensionContext, runId: string, plan: Plan, batch: Batch): void {
		const batchOrdinal = plan.batches.findIndex((candidate) => candidate.id === batch.id);
		if (batchOrdinal === -1) throw new Error(ERR_PLAN_BINDING);
		const current = snapshot(plan, batch);
		const preTaskAnchorId = appendBatchStart(this.pi, ctx, runId, current);
		this.#plans.set(sid(ctx), plan);
		this.set(ctx, activeState("running", runId, plan, batch, batchOrdinal, preTaskAnchorId));
		const prompt = ["[Queued task]", "", QUEUED_RULE, "", plan.preamble, "", batch.markdown]
			.filter((part, index, values) => part || (index > 0 && values[index - 1] !== ""))
			.join("\n");
		if (ctx.isIdle()) this.pi.sendUserMessage(prompt);
		else this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	private hasPlanningWrite(ctx: ExtensionContext, planId: string): boolean {
		return (ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>).some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === PLAN_WRITE_ENTRY &&
				(entry.data as { planId?: string } | undefined)?.planId === planId,
		);
	}

	private settledEnd(ctx: ExtensionContext, preTaskAnchorId: string): string | undefined {
		const entries = ctx.sessionManager.getBranch() as Array<{
			id: string;
			type: string;
			message?: { role?: string };
		}>;
		const start = entries.findIndex((entry) => entry.id === preTaskAnchorId);
		if (start === -1) return undefined;
		const hasAssistant = entries
			.slice(start + 1)
			.some((entry) => entry.type === "message" && entry.message?.role === "assistant");
		return hasAssistant ? (ctx.sessionManager.getLeafId() ?? undefined) : undefined;
	}

	private async onSettled(ctx: ExtensionContext): Promise<void> {
		const state = this.state(ctx);
		if (state.phase !== "running" || this.#busy.has(sid(ctx))) return;
		const lastSettledEntryId = ctx.sessionManager.getLeafId();
		if (!lastSettledEntryId) return;
		const commandCtx = this.#commandContexts.get(sid(ctx));
		if (!commandCtx) {
			this.set(ctx, { ...state, lastSettledEntryId });
			return;
		}
		await this.finishBatch(commandCtx, state, lastSettledEntryId);
	}

	private async finishBatch(
		ctx: ExtensionCommandContext,
		state: Extract<WorkstreamState, { batchId: string }>,
		lastSettledEntryId: string,
	): Promise<void> {
		const id = sid(ctx);
		if (this.#busy.has(id)) return;
		this.#busy.add(id);
		let acceptedState: Extract<WorkstreamState, { batchId: string }> = state;
		try {
			const plan = await findPlan(state.planId, planRoot(ctx.cwd));
			const batch = batchById(plan, state.batchId);
			if (!batch) throw new Error(ERR_PLAN_BINDING);
			if (plan.structuralRevision !== state.structuralRevision) {
				this.pause(ctx, state, "stale_structure");
				return;
			}
			const currentSnapshot = snapshot(plan, batch);
			if (state.lastCompressionOperationId && !sameBitmap(currentSnapshot.bitmap, state.preCompletionBitmap)) {
				this.pause(ctx, state, "stale_bitmap");
				return;
			}
			if (state.lastCompressionOperationId && currentSnapshot.fileRevision !== state.fileRevision) {
				this.pause(ctx, state, "stale_file");
				return;
			}
			const operationId = randomUUID();
			acceptedState = activeState("compressing", state.runId, plan, batch, state.batchOrdinal, state.preTaskAnchorId, {
				lastSettledEntryId,
				lastCompressionOperationId: operationId,
			});
			this.#plans.set(id, plan);
			this.set(ctx, acceptedState);
			const compression = prepareCompression(ctx, state.preTaskAnchorId, lastSettledEntryId, operationId);
			const summary = await reviewSummary(ctx, compression.source);
			if (!summary) {
				this.#busy.delete(id);
				this.set(ctx, { ...acceptedState, phase: "running" });
				ctx.ui.notify("Summary review was cancelled. The task-plan batch remains incomplete.", "warning");
				return;
			}
			const freshPlan = await findPlan(acceptedState.planId, planRoot(ctx.cwd));
			const freshBatch = batchById(freshPlan, acceptedState.batchId);
			if (!freshBatch || freshPlan.id !== acceptedState.planId) {
				this.pause(ctx, acceptedState, "plan_binding_mismatch");
				return;
			}
			if (freshPlan.structuralRevision !== acceptedState.structuralRevision) {
				this.pause(ctx, acceptedState, "stale_structure");
				return;
			}
			if (
				!sameBitmap(
					freshBatch.tasks.map((task) => task.checked),
					acceptedState.preCompletionBitmap,
				)
			) {
				this.pause(ctx, acceptedState, "stale_bitmap");
				return;
			}
			if (freshPlan.fileRevision !== acceptedState.fileRevision) {
				this.pause(ctx, acceptedState, "stale_file");
				return;
			}
			const freshCompression = revalidateCompression(ctx, compression);
			this.#mutating.add(id);
			try {
				await applyCompression(
					this.pi,
					ctx,
					acceptedState.runId,
					stateSnapshot(acceptedState),
					freshCompression,
					summary,
				);
			} finally {
				this.#mutating.delete(id);
			}
			await this.finishApplied(
				ctx,
				acceptedState.runId,
				freshPlan,
				freshBatch,
				acceptedState.preCompletionBitmap,
				acceptedState.fileRevision,
			);
		} catch (error) {
			const current = this.state(ctx);
			if (isActive(current) && current.phase !== "paused") this.pause(ctx, current, this.pauseCode(error));
			ctx.ui.notify(this.message(error), "error");
		} finally {
			this.#busy.delete(id);
		}
	}

	private async finishApplied(
		ctx: ExtensionCommandContext,
		runId: string,
		plan: Plan,
		batch: Batch,
		preCompletionBitmap: boolean[],
		fileRevision: string,
	): Promise<void> {
		const expected: BatchSnapshot = {
			planId: plan.id,
			batchId: batch.id,
			structuralRevision: plan.structuralRevision,
			fileRevision,
			bitmap: [...preCompletionBitmap],
		};
		let completed: Plan;
		try {
			completed = batch.tasks.every((task) => task.checked) ? plan : await completeBatch(plan, expected);
		} catch (error) {
			const state = this.state(ctx);
			if (isActive(state)) this.pause(ctx, state, "completion_failed");
			throw error;
		}
		this.#plans.set(sid(ctx), completed);
		const next = firstIncompleteBatch(completed);
		if (!next) {
			this.set(ctx, { v: VERSION, phase: "complete", runId, planId: completed.id });
			return;
		}
		if (completed.structuralRevision !== plan.structuralRevision) {
			const state = this.state(ctx);
			if (isActive(state)) this.pause(ctx, state, "stale_structure");
			return;
		}
		this.dispatch(ctx, runId, completed, next);
	}

	private pause(ctx: ExtensionContext, state: Extract<WorkstreamState, { batchId: string }>, code: PauseCode): void {
		this.set(ctx, { ...state, phase: "paused", code });
	}

	private pauseCode(error: unknown): PauseCode {
		const message = this.message(error).toLowerCase();
		if (message.includes("bound plan") || message.includes("plan is missing")) return "plan_binding_mismatch";
		if (message.includes("structure")) return "stale_structure";
		if (message.includes("session changed")) return "session_changed";
		if (message.includes("summary")) return "summary_failed";
		if (message.includes("range") || message.includes("queued batch")) return "invalid_range";
		return "completion_failed";
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

export default function piWorkstream(pi: ExtensionAPI): void {
	new Workstream(pi).register();
}
