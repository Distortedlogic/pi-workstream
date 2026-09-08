import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionUIContext,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { savePlan, snapshot, type Plan } from "../src/plan.ts";
import piWorkstream from "../src/workstream.ts";

const COMPLETE_TASK = () =>
	fauxAssistantMessage(fauxToolCall("workstream", { action: "complete_task" }), { stopReason: "toolUse" });

type Faux = ReturnType<typeof registerFauxProvider>;
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

function providerExtension(faux: Faux): (pi: ExtensionAPI) => void {
	return (pi) => {
		const model = faux.getModel();
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
			})),
		});
		piWorkstream(pi);
	};
}

async function startRuntime(
	tempDir: string,
	sessionManager: SessionManager,
	notifications: Harness["notifications"],
	widgets: Harness["widgets"],
	editor: Editor,
): Promise<{ runtime: AgentSessionRuntime; faux: Faux }> {
	const faux = registerFauxProvider({ models: [{ id: "workstream-faux", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const options = {
		agentDir: tempDir,
		authStorage,
		model: faux.getModel(),
		thinkingLevel: "off" as const,
		resourceLoaderOptions: {
			extensionFactories: [providerExtension(faux)],
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
	harness.faux.unregister();
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

function customEntries(harness: Harness, customType: string) {
	return harness.runtime.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function lastState(harness: Harness): Record<string, unknown> {
	const state = customEntries(harness, "pi-workstream/state").at(-1)?.data;
	if (!state || typeof state !== "object") throw new Error("workstream state was not persisted");
	return state as Record<string, unknown>;
}

function workstreamPrompts(harness: Harness): string[] {
	return harness.runtime.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map((entry) => (entry.type === "message" && entry.message.role === "user" ? entry.message.content : ""))
		.filter((content): content is string => typeof content === "string" && content.startsWith("[Workstream "));
}

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		if (!harness) continue;
		if (!harness.closed) await harness.runtime.dispose();
		harness.faux.unregister();
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
		await harness.runtime.session.waitForIdle();
		expect(lastState(harness).phase).toBe("review");

		await command(harness, "review");
		await harness.runtime.session.waitForIdle();
		expect(lastState(harness).phase).toBe("review");

		await command(harness, "review");
		expect(lastState(harness).phase).toBe("complete");
		expect(await readFile(harness.plan.path, "utf8")).toContain("- [x] first\n- [x] second");
		expect(await readFile(harness.plan.path, "utf8")).toContain("- [x] third");
		expect(customEntries(harness, "pi-workstream/batch-start")).toHaveLength(2);
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(2);
		expect(workstreamPrompts(harness)).toHaveLength(3);
		expect(new Set(workstreamPrompts(harness)).size).toBe(3);
		expect(harness.notifications.filter((item) => item.type === "error")).toEqual([]);
	});

	it("rejects a plan change after summary review without navigating or writing compression", async () => {
		let planPath = "";
		const harness = await createHarness(
			"# Changed Review\n\n## Batch\n\n- [ ] task\n",
			async (_title, prefill) => {
				await writeFile(planPath, `${await readFile(planPath, "utf8")}\nchanged after review\n`, "utf8");
				return prefill;
			},
		);
		planPath = harness.plan.path;
		harness.faux.setResponses([
			COMPLETE_TASK(),
			fauxAssistantMessage("task settled"),
			fauxAssistantMessage("summary"),
		]);

		await command(harness, `run ${harness.plan.path}`);
		await harness.runtime.session.waitForIdle();
		const leafBefore = harness.runtime.session.sessionManager.getLeafId();
		await command(harness, "review");

		expect(harness.runtime.session.sessionManager.getLeafId()).toBe(leafBefore);
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(0);
		expect(lastState(harness).phase).toBe("review");
		expect(harness.notifications.at(-1)).toMatchObject({ type: "error" });
	});

	it("restores review from a file-backed session and completes it after process recreation", async () => {
		const harness = await createHarness("# Replay Review\n\n## Batch\n\n- [ ] task\n");
		harness.faux.setResponses([COMPLETE_TASK(), fauxAssistantMessage("settled")]);
		await command(harness, `run ${harness.plan.path}`);
		await harness.runtime.session.waitForIdle();
		expect(lastState(harness).phase).toBe("review");

		await restart(harness);
		expect(lastState(harness).phase).toBe("review");
		harness.faux.setResponses([fauxAssistantMessage("summary after restart")]);
		await command(harness, "review");

		expect(lastState(harness).phase).toBe("complete");
		expect(customEntries(harness, "pi-workstream/compression")).toHaveLength(1);
	});

	it("advances once from a persisted compression marker", async () => {
		const harness = await createHarness(
			"# Replay Marker\n\n## First\n\n- [ ] one\n\n## Second\n\n- [ ] two\n",
		);
		harness.faux.setResponses([COMPLETE_TASK(), fauxAssistantMessage("settled")]);
		await command(harness, `run ${harness.plan.path}`);
		await harness.runtime.session.waitForIdle();
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
		await harness.runtime.session.waitForIdle();

		expect(lastState(harness).phase).toBe("running");
		expect(customEntries(harness, "pi-workstream/batch-start")).toHaveLength(2);
		expect(workstreamPrompts(harness).filter((prompt) => prompt.includes("Second"))).toHaveLength(1);
	});
});
