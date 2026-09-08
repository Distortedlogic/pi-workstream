import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import pWaitFor from "p-wait-for";
import { afterEach, expect, it } from "vitest";
import { savePlan } from "../src/plan.ts";
import piWorkstream from "../src/workstream.ts";

let runtime: AgentSessionRuntime | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	await runtime?.dispose();
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	runtime = undefined;
	tempDir = undefined;
});

function stateEntries() {
	return runtime?.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "pi-workstream/state") as
		| Array<{ data?: unknown }>
		| undefined;
}

function lastState(): Record<string, unknown> {
	const data = stateEntries()?.at(-1)?.data;
	if (!data || typeof data !== "object") throw new Error("workstream state was not persisted");
	return data as Record<string, unknown>;
}

async function runCommand(args: string): Promise<void> {
	if (!runtime) throw new Error("Pi runtime was not created");
	const runner = runtime.session.extensionRunner;
	const command = runner.getCommand("workstream");
	if (!command) throw new Error("workstream command was not registered");
	await command.handler(args, runner.createCommandContext());
}

it("completes one real-model workstream through review and context compression", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-workstream-real-"));
	const plan = await savePlan(
		[
			"# Real E2E",
			"",
			"## Execute",
			"",
			"- [ ] Call the workstream tool now with action complete_task. Do not use another tool.",
			"",
		].join("\n"),
		join(tempDir, ".pi", "plans"),
	);
	const agentDir = getAgentDir();
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				extensionFactories: [piWorkstream],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				thinkingLevel: "off",
				tools: ["workstream"],
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtimeHost = await createAgentSessionRuntime(factory, {
		cwd: tempDir,
		agentDir,
		sessionManager: SessionManager.create(tempDir, tempDir),
	});
	runtime = runtimeHost;

	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const editorDrafts: string[] = [];
	const runner = runtimeHost.session.extensionRunner;
	const uiContext: ExtensionUIContext = {
		...runner.getUIContext(),
		editor: async (_title, prefill) => {
			editorDrafts.push(prefill ?? "");
			return prefill;
		},
		notify(message, type) {
			notifications.push({ message, type });
		},
		setWidget() {},
		setStatus() {},
	};
	await runtimeHost.session.bindExtensions({
		mode: "rpc",
		uiContext,
		commandContextActions: {
			waitForIdle: () => runtimeHost.session.waitForIdle(),
			newSession: (options) => runtimeHost.newSession(options),
			fork: async (entryId, options) => {
				const result = await runtimeHost.fork(entryId, options);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await runtimeHost.session.navigateTree(targetId, options);
				return { cancelled: result.cancelled };
			},
			switchSession: (path, options) => runtimeHost.switchSession(path, options),
			reload: () => runtimeHost.session.reload(),
		},
	});

	await runCommand(`run ${plan.path}`);
	await pWaitFor(() => lastState().phase === "review", { timeout: 120000 });
	await runtime.session.waitForIdle();
	await runCommand("review");

	expect(lastState().phase).toBe("complete");
	expect(await readFile(plan.path, "utf8")).toContain("- [x] Call the workstream tool");
	expect(
		runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "pi-workstream/compression"),
	).toHaveLength(1);
	expect(editorDrafts).toHaveLength(1);
	expect(editorDrafts[0]).not.toBe("");
	expect(notifications.filter((item) => item.type === "error")).toEqual([]);
}, 180000);
