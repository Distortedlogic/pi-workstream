import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionFactory,
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
	extensions: ExtensionFactory[];
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
	extensions: ExtensionFactory[],
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
			extensionFactories: [piWorkstream, ...extensions],
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

async function createHarness(
	editor: Editor = async (_title, prefill) => prefill,
	extensions: ExtensionFactory[] = [],
): Promise<Harness> {
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
		extensions,
	);
	const harness = { tempDir, runtime, faux, notifications, widgets, editorDrafts, editor, extensions, closed: false };
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
		harness.extensions,
	);
	harness.runtime = replacement.runtime;
	harness.faux = replacement.faux;
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
	await writeFile(join(harness.tempDir, "context.txt"), "SOURCE_CONTEXT_SENTINEL\n", "utf8");
	harness.faux.setResponses([
		toolCall("read", { path: "context.txt" }),
		fauxAssistantMessage("Preloaded source context."),
	]);
	await harness.runtime.session.prompt("Read context.txt to build source context, then stop before planning.");
	await command(harness, "workstream", "plan");
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
	it("records the settled entry before planning metadata and does not move it on repeated calls", async () => {
		const harness = await createHarness();
		await command(harness, "workstream", "plan");
		expect(state(harness).phase).toBe("idle");
		harness.faux.setResponses([fauxAssistantMessage("Context building finished.")]);
		await harness.runtime.session.prompt("Build the required source context, then stop.");
		const anchorEntryId = harness.runtime.session.sessionManager.getLeafId();
		const sourceSessionId = harness.runtime.session.sessionManager.getSessionId();
		await command(harness, "workstream", "plan");
		expect(state(harness)).toEqual({ v: 2, phase: "planning", sourceSessionId, anchorEntryId });
		const entries = harness.runtime.session.sessionManager.getEntries();
		await command(harness, "workstream", "plan");
		expect(harness.runtime.session.sessionManager.getEntries()).toEqual(entries);
		expect(harness.editorDrafts).toHaveLength(0);
		await command(harness, "workstream", "run");
		expect(harness.runtime.session.sessionManager.getSessionId()).toBe(sourceSessionId);
		expect(harness.runtime.session.sessionManager.getEntries()).toEqual(entries);
		expect(harness.notifications.at(-1)?.message).toContain("Write the task plan successfully before approval");
	});

	it("binds canonical writes and refinements without moving the planning checkpoint", async () => {
		const harness = await createHarness();
		const plan = await createPlan(harness, "# Planning Flow\n\n## First\n\n- [ ] one\n");
		expect(plan.path).toBe(join(harness.tempDir, ".pi", "tasks", "Planning_Flow.md"));
		await expect(readFile(join(harness.tempDir, "agent-choice.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const checkpoint = state(harness);
		const refined = await refinePlan(harness, plan, "- [ ] one", "- [ ] one\n\n## Second\n\n- [ ] two");
		expect(state(harness)).toEqual(checkpoint);
		expect(checkpoint.planId).toBe(plan.id);
		expect(refined.batches.map((batch) => batch.title)).toEqual(["First", "Second"]);
		expect(harness.runtime.session.getActiveToolNames()).not.toContain("workstream");
		expect(harness.runtime.session.getActiveToolNames()).not.toContain("todo");
		expect(harness.runtime.session.extensionRunner.getCommand("workstream")).toBeDefined();
		expect(harness.runtime.session.extensionRunner.getCommand("queue")).toBeUndefined();
		expect(harness.runtime.session.extensionRunner.getCommand("todos")).toBeDefined();

		expect(state(harness).phase).toBe("planning");
		expect(queuedPrompts(harness)).toHaveLength(0);
	});

	it("leaves ordinary plan-shaped writes unchanged outside planning", async () => {
		const harness = await createHarness();
		const content = "# Ordinary Checklist\n\n## Work\n\n- [ ] ordinary task\n";
		harness.faux.setResponses([
			toolCall("write", { path: "ordinary.md", content }),
			fauxAssistantMessage("Written without planning."),
		]);
		await harness.runtime.session.prompt("Write an ordinary checklist.");
		expect(await readFile(join(harness.tempDir, "ordinary.md"), "utf8")).toBe(content);
		expect(state(harness).phase).toBe("idle");
		await expect(incompletePlan(planRoot(harness.tempDir))).rejects.toThrow("There is no incomplete task plan");
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
		await refinePlan(harness, plan, "first acceptance", "refined acceptance");
		const checkpoint = state(harness);
		const sourceFile = harness.runtime.session.sessionFile;
		if (!sourceFile || typeof checkpoint.anchorEntryId !== "string") throw new Error("Missing planning checkpoint");
		const sourceId = harness.runtime.session.sessionManager.getSessionId();
		const prefix = harness.runtime.session.sessionManager.getBranch(checkpoint.anchorEntryId);
		const sourceBytes = await readFile(sourceFile, "utf8");
		harness.faux.setResponses([
			fauxAssistantMessage("build execution finished"),
			fauxAssistantMessage("approved build summary"),
			fauxAssistantMessage("ship execution finished"),
			fauxAssistantMessage("approved ship summary"),
		]);

		await Promise.all([command(harness, "workstream", "run"), command(harness, "workstream", "run")]);
		await waitForPhase(harness, "complete");
		expect(harness.runtime.session.sessionManager.getSessionId()).not.toBe(sourceId);
		expect(harness.runtime.session.sessionManager.getEntries().slice(0, prefix.length)).toEqual(prefix);
		expect(await readFile(sourceFile, "utf8")).toBe(sourceBytes);
		expect(contextsAtReview[0]).toContain("SOURCE_CONTEXT_SENTINEL");
		expect(contextsAtReview[0]).not.toContain("Task plan written.");
		expect(contextsAtReview[0]).not.toContain("Refine the same technical task plan now.");
		expect(contextsAtReview[0]).not.toContain("Task plan refined.");
		const destinationId = harness.runtime.session.sessionManager.getSessionId();
		await command(harness, "workstream", "run");
		expect(harness.runtime.session.sessionManager.getSessionId()).toBe(destinationId);

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

	it("rejects checkpoint capture while the real agent has active and queued work", async () => {
		const harness = await createHarness();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("Context read finished.");
			},
			fauxAssistantMessage("Queued context work finished."),
		]);
		const prompt = harness.runtime.session.prompt("Build context while the model response is held.");
		try {
			await pWaitFor(() => harness.runtime.session.isStreaming, { timeout: 5000 });
			await harness.runtime.session.prompt("Finish the pending context work.", { streamingBehavior: "followUp" });
			await command(harness, "workstream", "plan");
			expect(state(harness).phase).toBe("idle");
			expect(harness.notifications.at(-1)?.message).toContain("Wait for the agent and pending messages");
		} finally {
			release();
			await prompt;
		}
		await command(harness, "workstream", "plan");
		expect(state(harness).phase).toBe("planning");
	});

	it("does not bind failed writes or collisions and protects the bound H1", async () => {
		let blockWrite = true;
		const harness = await createHarness(undefined, [
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "write" && blockWrite)
						return { block: true, reason: "Write rejected by another extension." };
				});
			},
		]);
		harness.faux.setResponses([fauxAssistantMessage("Context ready.")]);
		await harness.runtime.session.prompt("Build context.");
		await command(harness, "workstream", "plan");
		const checkpoint = state(harness);
		const content = "# Bound Plan\n\n## Work\n\n- [ ] task\n";
		harness.faux.setResponses([toolCall("write", { path: "any.md", content }), fauxAssistantMessage("Write failed.")]);
		await harness.runtime.session.prompt("Write the plan.");
		expect(state(harness)).toEqual(checkpoint);
		await expect(readFile(join(planRoot(harness.tempDir), "Bound_Plan.md"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		blockWrite = false;
		const occupied = "# AB\n\n## Work\n\n- [ ] existing\n";
		await writeFile(join(planRoot(harness.tempDir), "AB.md"), occupied, "utf8");
		harness.faux.setResponses([
			toolCall("write", { path: "other.md", content: "# A:B\n\n## Work\n\n- [ ] new\n" }),
			fauxAssistantMessage("Collision rejected."),
		]);
		await harness.runtime.session.prompt("Try a colliding plan title.");
		expect(state(harness)).toEqual(checkpoint);
		expect(await readFile(join(planRoot(harness.tempDir), "AB.md"), "utf8")).toBe(occupied);
		harness.faux.setResponses([toolCall("write", { path: "any.md", content }), fauxAssistantMessage("Plan written.")]);
		await harness.runtime.session.prompt("Write the bound plan.");
		const bound = await loadPlan(join(planRoot(harness.tempDir), "Bound_Plan.md"));
		expect(state(harness)).toEqual({ ...checkpoint, planId: bound.id });
		harness.faux.setResponses([
			toolCall("write", { path: bound.path, content: content.replace("# Bound Plan", "# Bound Plan!") }),
			fauxAssistantMessage("H1 rewrite rejected."),
		]);
		await harness.runtime.session.prompt("Try to change the H1.");
		await refinePlan(harness, bound, "# Bound Plan", "# Changed Plan");
		expect(await readFile(bound.path, "utf8")).toBe(content);
		expect(state(harness)).toEqual({ ...checkpoint, planId: bound.id });
	});

	it.each([
		{ name: "missing anchor", change: { anchorEntryId: "missing-entry" } },
		{ name: "foreign source session", change: { sourceSessionId: "another-session" } },
	])("rejects approval with a $name without creating a fork", async ({ change }) => {
		const harness = await createHarness();
		await createPlan(harness, "# Invalid Checkpoint\n\n## Work\n\n- [ ] task\n");
		harness.runtime.session.sessionManager.appendCustomEntry("pi-workstream/state", { ...state(harness), ...change });
		await restart(harness);
		const sourceId = harness.runtime.session.sessionManager.getSessionId();
		const before = harness.runtime.session.sessionManager.getEntries();
		await command(harness, "workstream", "run");
		expect(harness.runtime.session.sessionManager.getSessionId()).toBe(sourceId);
		expect(harness.runtime.session.sessionManager.getEntries()).toEqual(before);
		expect(queuedPrompts(harness)).toHaveLength(0);
		expect(harness.notifications.at(-1)?.type).toBe("error");
	});

	it("restores the planning checkpoint and binding after reload and process restart", async () => {
		const harness = await createHarness();
		await createPlan(harness, "# Restore Planning\n\n## Work\n\n- [ ] task\n");
		const checkpoint = state(harness);
		await harness.runtime.session.reload();
		expect(state(harness)).toEqual(checkpoint);
		await command(harness, "workstream", "plan");
		expect(state(harness)).toEqual(checkpoint);
		await restart(harness);
		expect(state(harness)).toEqual(checkpoint);
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(harness, "workstream", "run");
		await waitForPhase(harness, "complete");
		expect(queuedPrompts(harness)).toHaveLength(1);
	});

	it("leaves the planning session and file unchanged when the native fork is cancelled", async () => {
		let cancel = true;
		const harness = await createHarness(undefined, [
			(pi) => {
				pi.on("session_before_fork", () => ({ cancel }));
			},
		]);
		const plan = await createPlan(harness, "# Cancel Fork\n\n## Work\n\n- [ ] task\n");
		const sourceId = harness.runtime.session.sessionManager.getSessionId();
		const sourceFile = harness.runtime.session.sessionFile;
		if (!sourceFile) throw new Error("Missing source session file");
		const sourceBytes = await readFile(sourceFile, "utf8");
		const planBytes = await readFile(plan.path, "utf8");
		const checkpoint = state(harness);
		await command(harness, "workstream", "run");
		expect(harness.runtime.session.sessionManager.getSessionId()).toBe(sourceId);
		expect(state(harness)).toEqual(checkpoint);
		expect(await readFile(sourceFile, "utf8")).toBe(sourceBytes);
		expect(await readFile(plan.path, "utf8")).toBe(planBytes);
		expect(queuedPrompts(harness)).toHaveLength(0);
		cancel = false;
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(harness, "workstream", "run");
		await waitForPhase(harness, "complete");
		expect(queuedPrompts(harness)).toHaveLength(1);
	});

	it("stops a changed approval in the destination and resumes startup once after restart", async () => {
		let planPath = "";
		let original = "";
		const harness = await createHarness(undefined, [
			(pi) => {
				pi.on("session_start", async (event) => {
					if (event.reason === "fork") await writeFile(planPath, `${original}\nChanged during fork.\n`, "utf8");
				});
			},
		]);
		const plan = await createPlan(harness, "# Startup Recovery\n\n## Work\n\n- [ ] task\n");
		planPath = plan.path;
		original = await readFile(planPath, "utf8");
		await command(harness, "workstream", "run");
		expect(state(harness).phase).toBe("starting");
		expect(queuedPrompts(harness)).toHaveLength(0);
		const destinationId = harness.runtime.session.sessionManager.getSessionId();
		const runId = state(harness).runId;
		await writeFile(planPath, original, "utf8");
		await restart(harness);
		expect(state(harness).phase).toBe("starting");
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await Promise.all([command(harness, "workstream", "run"), command(harness, "workstream", "run")]);
		await waitForPhase(harness, "complete");
		expect(harness.runtime.session.sessionManager.getSessionId()).toBe(destinationId);
		expect(state(harness).runId).toBe(runId);
		expect(queuedPrompts(harness)).toHaveLength(1);
	});

	it("keeps a cancelled batch incomplete and retries automatically after user steering", async () => {
		let reviewCount = 0;
		const harness = await createHarness(async (_title, prefill) => {
			reviewCount += 1;
			return reviewCount === 1 ? undefined : prefill;
		});
		const plan = await createPlan(harness, "# Cancel Review\n\n## Batch\n\n- [ ] task\n");
		harness.faux.setResponses([fauxAssistantMessage("initial execution"), fauxAssistantMessage("first summary")]);
		await command(harness, "workstream", "run");
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
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);

		await command(harness, "workstream", "run");
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
		harness.faux.setResponses([
			fauxAssistantMessage("execution"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("intervening response"),
		]);

		await command(harness, "workstream", "run");
		await waitForPhase(harness, "paused");
		expect(state(harness)).toMatchObject({ phase: "paused", code: "session_changed" });
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
	});

	it("retries a cancelled reviewed range after process recreation through /workstream run", async () => {
		let reviewCount = 0;
		const harness = await createHarness(async (_title, prefill) => {
			reviewCount += 1;
			return reviewCount === 1 ? undefined : prefill;
		});
		const plan = await createPlan(harness, "# Restart Review\n\n## Batch\n\n- [ ] task\n");
		harness.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("first summary")]);
		await command(harness, "workstream", "run");
		await pWaitFor(
			() =>
				reviewCount === 1 &&
				harness.notifications.some((item) => item.message.startsWith("Summary review was cancelled")),
			{ timeout: 5000 },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		await restart(harness);
		harness.faux.setResponses([fauxAssistantMessage("summary after restart")]);
		await command(harness, "workstream", "run");
		await waitForPhase(harness, "complete");
		expect(reviewCount).toBe(2);
		expect(await readFile(plan.path, "utf8")).toContain("- [x] task");
	});

	it("fails closed when an active plan is missing or a completed bound plan is duplicated", async () => {
		const missing = await createHarness(async () => undefined);
		const missingPlan = await createPlan(missing, "# Missing Active\n\n## Batch\n\n- [ ] task\n");
		missing.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(missing, "workstream", "run");
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
		completed.faux.setResponses([fauxAssistantMessage("execution"), fauxAssistantMessage("summary")]);
		await command(completed, "workstream", "run");
		await waitForPhase(completed, "complete");

		const duplicateDir = join(completed.tempDir, ".pi", "tasks", "duplicate");
		await mkdir(duplicateDir, { recursive: true });
		await writeFile(join(duplicateDir, "Duplicate_Complete.md"), await readFile(completedPlan.path, "utf8"), "utf8");
		await restart(completed);
		expect(state(completed)).toMatchObject({ phase: "paused", code: "plan_binding_mismatch" });
	});
});
