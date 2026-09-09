import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { textOfContent } from "@pi-context-tree/core";
import pWaitFor from "p-wait-for";
import { afterEach, describe, expect, it } from "vitest";
import { type Plan, incompletePlan, loadPlan, planRoot } from "../src/plan.ts";
import { QUEUED_TASK_TAIL } from "../src/session.ts";
import piWorkstream from "../src/workstream.ts";

const toolCall = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

type Faux = ReturnType<typeof fauxProvider>;
type Editor = (title: string, prefill: string | undefined) => Promise<string | undefined>;

interface Harness {
	tempDir: string;
	runtime: AgentSessionRuntime;
	faux: Faux;
	notifications: Array<{ message: string; type: string | undefined }>;
	widgets: Array<string[] | undefined>;
	editorDrafts: string[];
	editor: Editor;
	closed: boolean;
}

const harnesses: Harness[] = [];

async function startRuntime(
	tempDir: string,
	sessionManager: SessionManager,
	notifications: Harness["notifications"],
	widgets: Harness["widgets"],
	editorDrafts: Harness["editorDrafts"],
	editor: Editor,
): Promise<{ runtime: AgentSessionRuntime; faux: Faux }> {
	const faux = fauxProvider({ models: [{ id: "workstream-faux", reasoning: false }] });
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(tempDir, "auth.json"),
		modelsPath: join(tempDir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const options = {
		agentDir: tempDir,
		modelRuntime,
		model,
		thinkingLevel: "off" as const,
		resourceLoaderOptions: {
			extensionFactories: [piWorkstream],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	};
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ ...options, cwd });
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: manager,
				sessionStartEvent,
				model: faux.getModel(),
				thinkingLevel: "off",
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd: tempDir, agentDir: tempDir, sessionManager });

	const bind = async (session: AgentSession): Promise<void> => {
		const runner = session.extensionRunner;
		const baseUI = runner.getUIContext();
		const uiContext: ExtensionUIContext = {
			...baseUI,
			async editor(title, prefill) {
				editorDrafts.push(prefill ?? "");
				return editor(title, prefill);
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget(_key, content) {
				widgets.push(Array.isArray(content) ? (content as string[]) : undefined);
			},
			setStatus() {},
		};
		await session.bindExtensions({
			mode: "rpc",
			uiContext,
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: (runtimeOptions) => runtime.newSession(runtimeOptions),
				fork: async (entryId, runtimeOptions) => {
					const result = await runtime.fork(entryId, runtimeOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, runtimeOptions) => {
					const result = await runtime.session.navigateTree(targetId, runtimeOptions);
					return { cancelled: result.cancelled };
				},
				switchSession: (path, runtimeOptions) => runtime.switchSession(path, runtimeOptions),
				reload: () => runtime.session.reload(),
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return { runtime, faux };
}

async function createHarness(editor: Editor = async (_title, prefill) => prefill): Promise<Harness> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-workstream-integration-"));
	const notifications: Harness["notifications"] = [];
	const widgets: Harness["widgets"] = [];
	const editorDrafts: string[] = [];
	const { runtime, faux } = await startRuntime(
		tempDir,
		SessionManager.create(tempDir, tempDir),
		notifications,
		widgets,
		editorDrafts,
		editor,
	);
	const harness = { tempDir, runtime, faux, notifications, widgets, editorDrafts, editor, closed: false };
	harnesses.push(harness);
	return harness;
}

async function restart(harness: Harness): Promise<void> {
	const sessionFile = harness.runtime.session.sessionFile;
	if (!sessionFile) throw new Error("Expected a persisted Pi session file");
	await harness.runtime.dispose();
	const replacement = await startRuntime(
		harness.tempDir,
		SessionManager.open(sessionFile, harness.tempDir),
		harness.notifications,
		harness.widgets,
		harness.editorDrafts,
		harness.editor,
	);
	harness.runtime = replacement.runtime;
	harness.faux = replacement.faux;
}

async function newSession(harness: Harness): Promise<void> {
	const result = await harness.runtime.newSession();
	if (result.cancelled) throw new Error("Pi cancelled the clean execution session");
}

async function command(harness: Harness, name: string, args = ""): Promise<void> {
	const runner = harness.runtime.session.extensionRunner;
	const registered = runner.getCommand(name);
	if (!registered) throw new Error(`${name} command was not registered`);
	await registered.handler(args, runner.createCommandContext());
}

function customEntries(harness: Harness, customType: string): Array<{ data?: unknown }> {
	return harness.runtime.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType) as Array<{ data?: unknown }>;
}

function state(harness: Harness): Record<string, unknown> {
	const value = customEntries(harness, "pi-workstream/state").at(-1)?.data;
	return value && typeof value === "object" ? (value as Record<string, unknown>) : { phase: "idle" };
}

async function waitForPhase(harness: Harness, phase: string): Promise<void> {
	try {
		await pWaitFor(() => state(harness).phase === phase, { timeout: 5000 });
	} catch (error) {
		const messages = harness.runtime.session.messages.map((message) => ({
			role: message.role,
			content: "content" in message ? message.content : undefined,
			...("stopReason" in message ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
		}));
		throw new Error(
			`Timed out waiting for ${phase}: state=${JSON.stringify(state(harness))} states=${JSON.stringify(customEntries(harness, "pi-workstream/state").map((entry) => entry.data))} pendingResponses=${harness.faux.getPendingResponseCount()} drafts=${JSON.stringify(harness.editorDrafts)} messages=${JSON.stringify(messages)} notifications=${JSON.stringify(harness.notifications)}`,
			{ cause: error },
		);
	}
}

function queuedPrompts(harness: Harness): string[] {
	return harness.runtime.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [textOfContent(entry.message.content)] : [],
		)
		.filter((content) => content.startsWith("[Queued task]\n\n"));
}

async function createPlan(harness: Harness, markdown: string): Promise<Plan> {
	harness.faux.setResponses([
		toolCall("write", { path: join(harness.tempDir, "agent-choice.md"), content: markdown }),
		fauxAssistantMessage("Task plan written."),
	]);
	await harness.runtime.session.prompt("Write the technical task plan now.");
	await harness.runtime.session.waitForIdle();
	return incompletePlan(planRoot(harness.tempDir));
}

async function refinePlan(harness: Harness, plan: Plan, oldText: string, newText: string): Promise<Plan> {
	harness.faux.setResponses([
		toolCall("edit", { path: plan.path, edits: [{ oldText, newText }] }),
		fauxAssistantMessage("Task plan refined."),
	]);
	await harness.runtime.session.prompt("Refine the same technical task plan now.");
	await harness.runtime.session.waitForIdle();
	return loadPlan(plan.path);
}

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		if (!harness) continue;
		if (!harness.closed) await harness.runtime.dispose();
		await rm(harness.tempDir, { recursive: true, force: true });
	}
});

describe("pi-workstream on the real Pi runtime", () => {
	it("redirects planning writes, permits canonical refinement, removes the agent tool, and requires a clean run session", async () => {
		const harness = await createHarness();
		const plan = await createPlan(harness, "# Planning Flow\n\n## First\n\n- [ ] one\n");
		expect(plan.path).toBe(join(harness.tempDir, ".pi", "tasks", "Planning_Flow.md"));
		await expect(readFile(join(harness.tempDir, "agent-choice.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const refined = await refinePlan(harness, plan, "- [ ] one", "- [ ] one\n\n## Second\n\n- [ ] two");
		expect(refined.batches.map((batch) => batch.title)).toEqual(["First", "Second"]);
		expect(harness.runtime.session.getActiveToolNames()).not.toContain("workstream");
		expect(harness.runtime.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.runtime.session.extensionRunner.getCommand("workstream")).toBeUndefined();
		expect(harness.runtime.session.extensionRunner.getCommand("queue")).toBeDefined();
		expect(harness.runtime.session.extensionRunner.getCommand("todos")).toBeDefined();

		await command(harness, "queue", "run");
		expect(state(harness).phase).toBe("idle");
		expect(queuedPrompts(harness)).toHaveLength(0);
		expect(harness.notifications.at(-1)?.message).toContain("Start a new Pi session");
	});

	it("runs whole H2 batches through automatic settled review, compression, completion, and dispatch", async () => {
		const holder: { harness?: Harness } = {};
		const contextsAtReview: string[] = [];
		const harness = await createHarness(async (_title, prefill) => {
			const current = holder.harness;
			if (current) {
				contextsAtReview.push(JSON.stringify(current.runtime.session.messages));
			}
			return prefill;
		});
		holder.harness = harness;
		const plan = await createPlan(
			harness,
			"# Runtime Flow\n\nShared rule.\n\n## Build\n\n- [ ] first batch work\n- [ ] first acceptance\n\n## Ship\n\n- [ ] hidden future work\n",
		);
		await newSession(harness);
		harness.faux.setResponses([
			fauxAssistantMessage("build execution finished"),
			fauxAssistantMessage("approved build summary"),
			fauxAssistantMessage("ship execution finished"),
			fauxAssistantMessage("approved ship summary"),
		]);

		await command(harness, "queue", "run");
		await waitForPhase(harness, "complete");

		const prompts = queuedPrompts(harness);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("Shared rule.");
		expect(prompts[0]).toContain("## Build");
		expect(prompts[0]).not.toContain("## Ship");
		expect(prompts[0]).not.toContain("hidden future work");
		expect(prompts[1]).toContain("## Ship");
		expect(contextsAtReview[0]).not.toContain("## Ship");
		expect(contextsAtReview[0]).not.toContain("hidden future work");
		expect((await readFile(plan.path, "utf8")).match(/- \[x\]/g)).toHaveLength(3);
		const compressions = customEntries(harness, "pi-workstream/compression");
		expect(compressions).toHaveLength(2);
		expect(compressions.map((entry) => (entry.data as { preCompletionBitmap: boolean[] }).preCompletionBitmap)).toEqual(
			[[false, false], [false]],
		);
		expect(harness.editorDrafts).toEqual(["approved build summary", "approved ship summary"]);
		const activeEntries = harness.runtime.session.sessionManager.getBranch();
		const activeQueuedPrompts = activeEntries.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === QUEUED_TASK_TAIL ? [textOfContent(entry.content)] : [],
		);
		expect(activeQueuedPrompts).toEqual(prompts);
		const activeBranch = JSON.stringify(activeEntries);
		expect(activeBranch).toContain("approved build summary");
		expect(activeBranch).toContain("approved ship summary");
		expect(activeBranch).not.toContain("build execution finished");
		expect(activeBranch).not.toContain("ship execution finished");
		const durableData = customEntries(harness, "pi-workstream/state")
			.concat(customEntries(harness, "pi-workstream/batch-start"))
			.concat(customEntries(harness, "pi-workstream/compression"))
			.map((entry) => JSON.stringify(entry.data))
			.join("\n");
		expect(durableData).not.toContain("hidden future work");
		expect(durableData).not.toContain(".pi/tasks");
	});

	it("keeps a cancelled batch incomplete and retries automatically after user steering", async () => {
		let reviewCount = 0;
		const harness = await createHarness(async (_title, prefill) => {
			reviewCount += 1;
			return reviewCount === 1 ? undefined : prefill;
		});
		const plan = await createPlan(harness, "# Cancel Review\n\n## Batch\n\n- [ ] task\n");
		await newSession(harness);
		harness.faux.setResponses([fauxAssistantMessage("initial execution"), fauxAssistantMessage("first summary")]);
		await command(harness, "queue", "run");
		await pWaitFor(
			() =>
				reviewCount === 1 &&
				harness.notifications.some((item) => item.message.startsWith("Summary review was cancelled")),
			{ timeout: 5000 },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(state(harness).phase).toBe("running");
		expect(await readFile(plan.path, "utf8")).toContain("- [ ] task");
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);

		harness.faux.setResponses([fauxAssistantMessage("steering applied"), fauxAssistantMessage("second summary")]);
		await harness.runtime.session.prompt("Apply this steering before the batch is summarized.");
		await waitForPhase(harness, "complete");
		expect(reviewCount).toBe(2);
		expect(await readFile(plan.path, "utf8")).toContain("- [x] task");
	});

	it("rejects a plan change after summary approval without session mutation or checkbox completion", async () => {
		const holder: { plan?: Plan } = {};
		const harness = await createHarness(async (_title, prefill) => {
			const plan = holder.plan;
			if (plan) await writeFile(plan.path, `${await readFile(plan.path, "utf8")}\nchanged after review\n`, "utf8");
			return prefill;
		});
		holder.plan = await createPlan(harness, "# Changed Plan\n\n## Batch\n\n- [ ] task\n");
		await newSession(harness);
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);

		await command(harness, "queue", "run");
		await waitForPhase(harness, "paused");
		expect(state(harness)).toMatchObject({ phase: "paused", code: "stale_structure" });
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
		expect(await readFile(holder.plan.path, "utf8")).toContain("- [ ] task");
	});

	it("rejects new session content after summary approval without applying compression", async () => {
		const holder: { harness?: Harness } = {};
		const harness = await createHarness(async (_title, prefill) => {
			const current = holder.harness;
			if (current) {
				await current.runtime.session.prompt("intervening session content");
				await current.runtime.session.waitForIdle();
			}
			return prefill;
		});
		holder.harness = harness;
		await createPlan(harness, "# Changed Session\n\n## Batch\n\n- [ ] task\n");
		await newSession(harness);
		harness.faux.setResponses([
			fauxAssistantMessage("execution"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("intervening response"),
		]);

		await command(harness, "queue", "run");
		await waitForPhase(harness, "paused");
		expect(state(harness)).toMatchObject({ phase: "paused", code: "session_changed" });
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
	});

	it("retries a cancelled reviewed range after process recreation through /queue run", async () => {
		let reviewCount = 0;
		const harness = await createHarness(async (_title, prefill) => {
			reviewCount += 1;
			return reviewCount === 1 ? undefined : prefill;
		});
		const plan = await createPlan(harness, "# Restart Review\n\n## Batch\n\n- [ ] task\n");
		await newSession(harness);
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("first summary")]);
		await command(harness, "queue", "run");
		await pWaitFor(
			() =>
				reviewCount === 1 &&
				harness.notifications.some((item) => item.message.startsWith("Summary review was cancelled")),
			{ timeout: 5000 },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		await restart(harness);
		harness.faux.setResponses([fauxAssistantMessage("summary after restart")]);
		await command(harness, "queue", "run");
		await waitForPhase(harness, "complete");
		expect(reviewCount).toBe(2);
		expect(await readFile(plan.path, "utf8")).toContain("- [x] task");
	});

	it("fails closed when an active plan is missing or a completed bound plan is duplicated", async () => {
		const missing = await createHarness(async () => undefined);
		const missingPlan = await createPlan(missing, "# Missing Active\n\n## Batch\n\n- [ ] task\n");
		await newSession(missing);
		missing.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(missing, "queue", "run");
		await pWaitFor(
			() => missing.notifications.some((item) => item.message.startsWith("Summary review was cancelled")),
			{ timeout: 5000 },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await rm(missingPlan.path);
		await restart(missing);
		expect(state(missing)).toMatchObject({ phase: "paused", code: "plan_binding_mismatch" });

		const completed = await createHarness();
		const completedPlan = await createPlan(completed, "# Duplicate Complete\n\n## Batch\n\n- [ ] task\n");
		await newSession(completed);
		completed.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(completed, "queue", "run");
		await waitForPhase(completed, "complete");

		const duplicateDir = join(completed.tempDir, ".pi", "tasks", "duplicate");
		await mkdir(duplicateDir, { recursive: true });
		await writeFile(join(duplicateDir, "Duplicate_Complete.md"), await readFile(completedPlan.path, "utf8"), "utf8");
		await restart(completed);
		expect(state(completed)).toMatchObject({ phase: "paused", code: "plan_binding_mismatch" });
	});
});
