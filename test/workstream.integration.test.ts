import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
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
import { type Plan, savePlan, snapshot } from "../src/plan.ts";
import piWorkstream from "../src/workstream.ts";

const COMPLETE_TASK = () =>
	fauxAssistantMessage(fauxToolCall("workstream", { action: "complete_task" }), { stopReason: "toolUse" });

type Faux = ReturnType<typeof fauxProvider>;
type Editor = (title: string, prefill: string | undefined) => Promise<string | undefined>;

interface Harness {
	tempDir: string;
	plan: Plan;
	runtime: AgentSessionRuntime;
	faux: Faux;
	notifications: Array<{ message: string; type: string | undefined }>;
	widgets: Array<string[] | undefined>;
	editor: Editor;
	closed: boolean;
}

const harnesses: Harness[] = [];

async function startRuntime(
	tempDir: string,
	sessionManager: SessionManager,
	notifications: Harness["notifications"],
	widgets: Harness["widgets"],
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
	const runner = runtime.session.extensionRunner;
	const baseUI = runner.getUIContext();
	const uiContext: ExtensionUIContext = {
		...baseUI,
		editor,
		notify(message, type) {
			notifications.push({ message, type });
		},
		setWidget(_key, content) {
			widgets.push(Array.isArray(content) ? (content as string[]) : undefined);
		},
		setStatus() {},
	};
	await runtime.session.bindExtensions({
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
	return { runtime, faux };
}

async function createHarness(markdown: string, editor?: Editor): Promise<Harness> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-workstream-e2e-"));
	const plan = await savePlan(markdown, join(tempDir, ".pi", "plans"));
	const notifications: Harness["notifications"] = [];
	const widgets: Harness["widgets"] = [];
	const reviewEditor: Editor = editor ?? (async (_title, prefill) => prefill);
	const { runtime, faux } = await startRuntime(
		tempDir,
		SessionManager.create(tempDir, tempDir),
		notifications,
		widgets,
		reviewEditor,
	);
	const harness = { tempDir, plan, runtime, faux, notifications, widgets, editor: reviewEditor, closed: false };
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
		harness.editor,
	);
	harness.runtime = replacement.runtime;
	harness.faux = replacement.faux;
}

async function command(harness: Harness, args: string): Promise<void> {
	const runner = harness.runtime.session.extensionRunner;
	const registered = runner.getCommand("workstream");
	if (!registered) throw new Error("workstream command was not registered");
	await registered.handler(args, runner.createCommandContext());
}

function customEntries(harness: Harness, customType: string): Array<{ data?: unknown }> {
	return harness.runtime.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType) as Array<{ data?: unknown }>;
}

function lastState(harness: Harness): Record<string, unknown> {
	const state = customEntries(harness, "pi-workstream/state").at(-1)?.data;
	if (!state || typeof state !== "object") throw new Error("workstream state was not persisted");
	return state as Record<string, unknown>;
}

async function waitForPhase(harness: Harness, phase: string): Promise<void> {
	try {
		await pWaitFor(() => lastState(harness).phase === phase, { timeout: 3000 });
	} catch (error) {
		const messages = harness.runtime.session.messages.map((message) => ({
			role: message.role,
			content: "content" in message ? message.content : undefined,
			...("stopReason" in message ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
		}));
		throw new Error(
			`Timed out waiting for ${phase}: state=${JSON.stringify(lastState(harness))} pendingResponses=${harness.faux.getPendingResponseCount()} messages=${JSON.stringify(messages)} notifications=${JSON.stringify(harness.notifications)}`,
			{ cause: error },
		);
	}
}

function workstreamPrompts(harness: Harness): string[] {
	return harness.runtime.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [textOfContent(entry.message.content)] : [],
		)
		.filter((content) => content.startsWith("[Workstream "));
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
	it("runs two batches through real tools, review, navigation, and compression exactly once", async () => {
		const harness = await createHarness(
			"# Runtime Flow\n\n## Build\n\n- [ ] first\n- [ ] second\n\n## Ship\n\n- [ ] third\n",
		);
		harness.faux.setResponses([
			COMPLETE_TASK(),
			fauxAssistantMessage("first settled"),
			COMPLETE_TASK(),
			fauxAssistantMessage("second settled"),
			fauxAssistantMessage("approved build summary"),
			COMPLETE_TASK(),
			fauxAssistantMessage("third settled"),
			fauxAssistantMessage("approved ship summary"),
		]);

		await command(harness, `run ${harness.plan.path}`);
		await waitForPhase(harness, "review");
		expect(lastState(harness).phase).toBe("review");

		await command(harness, "review");
		await waitForPhase(harness, "review");
		expect(lastState(harness).phase).toBe("review");

		await command(harness, "review");
		expect(lastState(harness).phase).toBe("complete");
		expect(await readFile(harness.plan.path, "utf8")).toContain("- [x] first\n- [x] second");
		expect(await readFile(harness.plan.path, "utf8")).toContain("- [x] third");
		expect(customEntries(harness, "pi-workstream/batch-start")).toHaveLength(2);
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(2);
		expect(
			customEntries(harness, "pi-workstream/state").filter(
				(entry) => (entry.data as { phase?: string } | undefined)?.phase === "complete",
			),
		).toHaveLength(1);
		expect(workstreamPrompts(harness)).toHaveLength(3);
		expect(new Set(workstreamPrompts(harness)).size).toBe(3);
		expect(harness.notifications.filter((item) => item.type === "error")).toEqual([]);
	});

	it("rejects a plan change after summary review without navigating or writing compression", async () => {
		let planPath = "";
		const harness = await createHarness("# Changed Review\n\n## Batch\n\n- [ ] task\n", async (_title, prefill) => {
			await writeFile(planPath, `${await readFile(planPath, "utf8")}\nchanged after review\n`, "utf8");
			return prefill;
		});
		planPath = harness.plan.path;
		harness.faux.setResponses([COMPLETE_TASK(), fauxAssistantMessage("task settled"), fauxAssistantMessage("summary")]);

		await command(harness, `run ${harness.plan.path}`);
		await waitForPhase(harness, "review");
		const leafBefore = harness.runtime.session.sessionManager.getLeafId();
		await command(harness, "review");

		expect(harness.runtime.session.sessionManager.getLeafId()).toBe(leafBefore);
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
		expect(lastState(harness).phase).toBe("review");
		expect(harness.notifications.at(-1)).toMatchObject({ type: "error" });
	});

	it("rejects new session content after summary approval without applying compression", async () => {
		// biome-ignore lint/style/useConst: the editor callback needs the harness after createHarness returns.
		let harness: Harness;
		harness = await createHarness("# Changed Session\n\n## Batch\n\n- [ ] task\n", async (_title, prefill) => {
			await harness.runtime.session.prompt("intervening session content");
			await harness.runtime.session.waitForIdle();
			return prefill;
		});
		harness.faux.setResponses([
			COMPLETE_TASK(),
			fauxAssistantMessage("task settled"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("intervening response"),
		]);

		await command(harness, `run ${harness.plan.path}`);
		await waitForPhase(harness, "review");
		await command(harness, "review");

		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
		expect(lastState(harness).phase).toBe("review");
		expect(harness.notifications.at(-1)).toMatchObject({ type: "error" });
	});

	it("rejects missing active and duplicate completed plan bindings after restart", async () => {
		const active = await createHarness("# Missing Active\n\n## Batch\n\n- [ ] task\n");
		active.faux.setResponses([fauxAssistantMessage("leave task active")]);
		await command(active, `run ${active.plan.path}`);
		await pWaitFor(() => workstreamPrompts(active).length === 1, { timeout: 3000 });
		await active.runtime.session.waitForIdle();
		await rm(active.plan.path);
		await restart(active);
		expect(lastState(active)).toMatchObject({ phase: "failed", code: "plan_binding_mismatch" });

		const completed = await createHarness("# Duplicate Complete\n\n## Batch\n\n- [ ] task\n");
		completed.faux.setResponses([
			COMPLETE_TASK(),
			fauxAssistantMessage("task settled"),
			fauxAssistantMessage("summary"),
		]);
		await command(completed, `run ${completed.plan.path}`);
		await waitForPhase(completed, "review");
		await command(completed, "review");
		expect(lastState(completed).phase).toBe("complete");
		const duplicateDir = join(completed.tempDir, ".pi", "plans", "duplicate");
		await mkdir(duplicateDir, { recursive: true });
		await writeFile(join(duplicateDir, "duplicate-complete.md"), await readFile(completed.plan.path, "utf8"), "utf8");
		await restart(completed);
		expect(lastState(completed)).toMatchObject({ phase: "failed", code: "plan_binding_mismatch" });
	});

	it("restores review from a file-backed session and completes it after process recreation", async () => {
		const harness = await createHarness("# Replay Review\n\n## Batch\n\n- [ ] task\n");
		harness.faux.setResponses([COMPLETE_TASK(), fauxAssistantMessage("settled")]);
		await command(harness, `run ${harness.plan.path}`);
		await waitForPhase(harness, "review");
		expect(lastState(harness).phase).toBe("review");

		await restart(harness);
		expect(lastState(harness).phase).toBe("review");
		harness.faux.setResponses([fauxAssistantMessage("summary after restart")]);
		await command(harness, "review");

		expect(lastState(harness).phase).toBe("complete");
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(1);
	});

	it("advances once from a persisted compression marker", async () => {
		const harness = await createHarness("# Replay Marker\n\n## First\n\n- [ ] one\n\n## Second\n\n- [ ] two\n");
		harness.faux.setResponses([COMPLETE_TASK(), fauxAssistantMessage("settled")]);
		await command(harness, `run ${harness.plan.path}`);
		await waitForPhase(harness, "review");
		const state = lastState(harness);
		expect(state.phase).toBe("review");
		harness.runtime.session.sessionManager.appendCustomEntry("pi-workstream/compression", {
			v: 1,
			runId: state.runId,
			planId: (state.batch as Record<string, unknown>).planId,
			batchId: (state.batch as Record<string, unknown>).batchId,
			operationId: "interrupted-operation",
			sourceLeafId: harness.runtime.session.sessionManager.getLeafId(),
			selectedEntryIds: [],
			sourceSha256: "0".repeat(64),
		});

		harness.faux.setResponses([fauxAssistantMessage("leave second task active")]);
		await restart(harness);
		await pWaitFor(
			() =>
				lastState(harness).phase === "running" &&
				workstreamPrompts(harness).filter((prompt) => prompt.includes("Second")).length === 1,
			{ timeout: 3000 },
		);

		expect(lastState(harness).phase).toBe("running");
		expect(customEntries(harness, "pi-workstream/batch-start")).toHaveLength(2);
		expect(workstreamPrompts(harness).filter((prompt) => prompt.includes("Second"))).toHaveLength(1);
	});
});
