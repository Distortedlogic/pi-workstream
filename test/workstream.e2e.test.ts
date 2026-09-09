import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { textOfContent } from "@pi-context-tree/core";
import pWaitFor from "p-wait-for";
import { afterEach, expect, it } from "vitest";
import { incompletePlan, planRoot } from "../src/plan.ts";
import piWorkstream from "../src/workstream.ts";

let runtime: AgentSessionRuntime | undefined;
let tempDir: string | undefined;

afterEach(async () => {
	await runtime?.dispose();
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	runtime = undefined;
	tempDir = undefined;
});

function stateEntries(): Array<{ data?: unknown }> {
	return (runtime?.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "pi-workstream/state") ?? []) as Array<{
		data?: unknown;
	}>;
}

function lastState(): Record<string, unknown> {
	const data = stateEntries().at(-1)?.data;
	return data && typeof data === "object" ? (data as Record<string, unknown>) : { phase: "idle" };
}

async function runQueue(): Promise<void> {
	if (!runtime) throw new Error("Pi runtime was not created");
	const runner = runtime.session.extensionRunner;
	const command = runner.getCommand("queue");
	if (!command) throw new Error("queue command was not registered");
	await command.handler("run", runner.createCommandContext());
}

it("creates a plan and completes isolated batches with the real configured model", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-workstream-real-"));
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
				tools: ["read", "write"],
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
	const bind = async (session: AgentSession): Promise<void> => {
		const runner = session.extensionRunner;
		const uiContext: ExtensionUIContext = {
			...runner.getUIContext(),
			async editor(_title, prefill) {
				editorDrafts.push(prefill ?? "");
				return prefill;
			},
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget() {},
			setStatus() {},
		};
		await session.bindExtensions({
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
	};
	runtimeHost.setRebindSession(bind);
	await bind(runtimeHost.session);

	const markdown = [
		"# Real E2E",
		"",
		"Work only on the supplied current batch.",
		"",
		"## Create",
		"",
		"- [ ] Use the write tool to create result.txt containing exactly READY followed by a newline, then stop.",
		"",
		"## Verify",
		"",
		"- [ ] Use the read tool to verify result.txt, then use the write tool to create verified.txt containing exactly VERIFIED followed by a newline, then stop.",
		"",
	].join("\n");
	await runtimeHost.session.prompt(
		[
			"Use the write tool exactly once to write the Markdown task plan below.",
			"You can choose any output path. Preserve the Markdown exactly, then stop.",
			"",
			markdown,
		].join("\n"),
	);
	await runtimeHost.session.waitForIdle();
	const plan = await incompletePlan(planRoot(tempDir));
	const planningSessionFile = runtimeHost.session.sessionFile;
	if (!planningSessionFile) throw new Error("The planning session was not persisted");
	const replacement = await runtimeHost.newSession();
	if (replacement.cancelled) throw new Error("Pi cancelled the clean execution session");

	await runQueue();
	await pWaitFor(() => lastState().phase === "complete", { timeout: 180000 });
	await runtimeHost.session.waitForIdle();

	const queuedPrompts = runtimeHost.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [textOfContent(entry.message.content)] : [],
		)
		.filter((content) => content.startsWith("[Queued task]\n\n"));
	expect(plan.path).toBe(join(tempDir, ".pi", "tasks", "Real_E2E.md"));
	expect(runtimeHost.session.sessionFile).not.toBe(planningSessionFile);
	expect(queuedPrompts).toHaveLength(2);
	expect(queuedPrompts[0]).toContain("## Create");
	expect(queuedPrompts[0]).not.toContain("## Verify");
	expect(queuedPrompts[0]).not.toContain("verified.txt");
	expect(queuedPrompts[1]).toContain("## Verify");
	expect(await readFile(join(tempDir, "result.txt"), "utf8")).toBe("READY\n");
	expect(await readFile(join(tempDir, "verified.txt"), "utf8")).toBe("VERIFIED\n");
	expect((await readFile(plan.path, "utf8")).match(/- \[x\]/g)).toHaveLength(2);
	expect(
		runtimeHost.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "pi-workstream/compression"),
	).toHaveLength(2);
	expect(editorDrafts).toHaveLength(2);
	expect(editorDrafts.every((draft) => draft.length > 0)).toBe(true);
	expect(notifications.filter((item) => item.type === "error")).toEqual([]);
}, 240000);
