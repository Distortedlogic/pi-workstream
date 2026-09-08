import { type Static, Type } from "typebox";

export const WORKSTREAM_STATE_ENTRY = "pi-workstream/state";
export const WORKSTREAM_STATE_VERSION = 1;

const IdSchema = Type.String({ minLength: 1 });
const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const exact = { additionalProperties: false } as const;

export const RunBindingSchema = Type.Object({ runId: IdSchema, planId: HashSchema }, exact);
export const BatchSnapshotSchema = Type.Object(
	{
		planId: HashSchema,
		batchId: HashSchema,
		structuralRevision: HashSchema,
		fileRevision: HashSchema,
		checkboxBitmap: Type.Array(Type.Boolean()),
	},
	exact,
);
export const CompressionCheckpointSchema = Type.Object(
	{
		operationId: IdSchema,
		sourceLeafId: IdSchema,
		selectedEntryIds: Type.Array(IdSchema, { minItems: 1 }),
		sourceSha256: HashSchema,
	},
	exact,
);

const ActiveBase = {
	v: Type.Literal(WORKSTREAM_STATE_VERSION),
	run: RunBindingSchema,
	batch: BatchSnapshotSchema,
	batchStartEntryId: IdSchema,
};
const ActiveTaskBase = { ...ActiveBase, currentTaskIndex: Type.Integer({ minimum: 0 }) };
const ReviewBase = {
	...ActiveBase,
	completedTaskIndex: Type.Integer({ minimum: 0 }),
	preCompletionBitmap: Type.Array(Type.Boolean()),
	compression: CompressionCheckpointSchema,
};

export const WorkstreamStateSchema = Type.Union([
	Type.Object({ v: Type.Literal(WORKSTREAM_STATE_VERSION), phase: Type.Literal("idle") }, exact),
	Type.Object({ ...ActiveTaskBase, phase: Type.Literal("dispatching") }, exact),
	Type.Object({ ...ActiveTaskBase, phase: Type.Literal("executing") }, exact),
	Type.Object({ ...ActiveTaskBase, phase: Type.Literal("pausing"), reason: Type.String() }, exact),
	Type.Object(
		{
			...ActiveBase,
			phase: Type.Literal("paused"),
			nextTaskIndex: Type.Integer({ minimum: 0 }),
			reason: Type.String(),
		},
		exact,
	),
	Type.Object(
		{
			...ActiveBase,
			phase: Type.Literal("preparing_review"),
			completedTaskIndex: Type.Integer({ minimum: 0 }),
			preCompletionBitmap: Type.Array(Type.Boolean()),
		},
		exact,
	),
	Type.Object({ ...ReviewBase, phase: Type.Literal("reviewing") }, exact),
	Type.Object({ ...ReviewBase, phase: Type.Literal("revalidating") }, exact),
	Type.Object({ ...ReviewBase, phase: Type.Literal("applying") }, exact),
	Type.Object(
		{
			v: Type.Literal(WORKSTREAM_STATE_VERSION),
			phase: Type.Literal("failed"),
			scope: Type.Literal("unbound"),
			code: IdSchema,
			message: Type.String(),
		},
		exact,
	),
	Type.Object(
		{
			...ActiveBase,
			phase: Type.Literal("failed"),
			scope: Type.Literal("run"),
			code: IdSchema,
			message: Type.String(),
		},
		exact,
	),
	Type.Object(
		{
			v: Type.Literal(WORKSTREAM_STATE_VERSION),
			phase: Type.Literal("complete"),
			run: RunBindingSchema,
		},
		exact,
	),
]);

export type RunBinding = Static<typeof RunBindingSchema>;
export type CompressionCheckpoint = Static<typeof CompressionCheckpointSchema>;
export type WorkstreamState = Static<typeof WorkstreamStateSchema>;

export const IDLE_STATE: WorkstreamState = { v: WORKSTREAM_STATE_VERSION, phase: "idle" };
