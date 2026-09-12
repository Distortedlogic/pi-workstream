import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	RpcClient,
	type RpcExtensionUIRequest,
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

it("plans and refines after a context checkpoint, then executes in a native fork with the real model", async () => {
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
				tools: ["read", "write", "edit"],
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
	const reviewContexts: string[] = [];
	const bind = async (session: AgentSession): Promise<void> => {
		const runner = session.extensionRunner;
		const uiContext: ExtensionUIContext = {
			...runner.getUIContext(),
			async editor(_title, prefill) {
				reviewContexts.push(JSON.stringify(runtimeHost.session.messages));
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
	await writeFile(join(tempDir, "source-context.txt"), "PRELOAD_CONTEXT_SENTINEL: Preserve unrelated files.\n", "utf8");
	await runtimeHost.session.prompt(
		"Use read to read source-context.txt, report its rule, then stop. Do not plan or write files yet.",
	);
	await runtimeHost.session.waitForIdle();
	const preload = runtimeHost.session.sessionManager.getBranch();
	const anchorEntryId = runtimeHost.session.sessionManager.getLeafId();
	await runtimeHost.session.prompt("/workstream plan");
	expect(lastState()).toMatchObject({ phase: "planning", anchorEntryId });

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
	await runtimeHost.session.prompt(
		`Use edit once on ${plan.path}. Replace exactly "Work only on the supplied current batch." with "Work only on the supplied current batch. Preserve unrelated files." Keep all other text unchanged, then stop.`,
	);
	await runtimeHost.session.waitForIdle();
	expect(await readFile(plan.path, "utf8")).toContain("Preserve unrelated files.");
	expect(lastState()).toMatchObject({ phase: "planning", anchorEntryId, planId: plan.id });
	const planningSessionFile = runtimeHost.session.sessionFile;
	if (!planningSessionFile) throw new Error("The planning session was not persisted");
	const sourceBytes = await readFile(planningSessionFile, "utf8");

	await runtimeHost.session.prompt("/workstream run");
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
	expect(await readFile(planningSessionFile, "utf8")).toBe(sourceBytes);
	expect(runtimeHost.session.sessionManager.getEntries().slice(0, preload.length)).toEqual(preload);
	expect(reviewContexts[0]).toContain("PRELOAD_CONTEXT_SENTINEL");
	expect(reviewContexts[0]).not.toContain("verified.txt");
	expect(reviewContexts[0]).not.toContain("Markdown task plan below");
	expect(reviewContexts[0]).not.toContain("Use edit once on");
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

it("forks through the real CLI and RPC command path and opens automatic review", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pi-workstream-rpc-"));
	await writeFile(join(tempDir, "context.txt"), "RPC_CONTEXT_SENTINEL\n", "utf8");
	const client = new RpcClient({
		cwd: tempDir,
		cliPath: fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
		args: [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--session-dir",
			join(tempDir, "sessions"),
			"-e",
			fileURLToPath(new URL("../src/workstream.ts", import.meta.url)),
			"--tools",
			"read,write",
		],
	});
	let review: Extract<RpcExtensionUIRequest, { method: "editor" }> | undefined;
	const unsubscribe = client.onEvent((event) => {
		const request = event as unknown as RpcExtensionUIRequest;
		if (request.type === "extension_ui_request" && request.method === "editor") review = request;
	});
	try {
		await client.start();
		await client.promptAndWait(
			"Read context.txt with read, report its text, then stop before planning.",
			undefined,
			90000,
		);
		const preload = await client.getEntries();
		const source = await client.getState();
		await client.prompt("/workstream plan");
		await client.promptAndWait(
			[
				"Use write once to save this exact technical task plan to any path, then stop:",
				"# RPC Fork Plan",
				"",
				"## Execute",
				"",
				"- [ ] Use write to create rpc-result.txt containing exactly DONE followed by a newline, then stop.",
			].join("\n"),
			undefined,
			90000,
		);
		if (!source.sessionFile) throw new Error("The source RPC session has no file");
		const sourceBytes = await readFile(source.sessionFile, "utf8");
		await client.prompt("/workstream run");
		await pWaitFor(() => Boolean(review), { timeout: 120000 });
		const destination = await client.getState();
		const { entries } = await client.getEntries();
		const latest = entries
			.filter((entry) => entry.type === "custom" && entry.customType === "pi-workstream/state")
			.at(-1);
		expect(destination.sessionId).not.toBe(source.sessionId);
		expect(entries.slice(0, preload.entries.length)).toEqual(preload.entries);
		expect(await readFile(source.sessionFile, "utf8")).toBe(sourceBytes);
		expect(latest?.type === "custom" ? latest.data : undefined).toMatchObject({ phase: "compressing" });
		expect(review?.prefill?.trim()).toBeTruthy();
		expect(await readFile(join(tempDir, "rpc-result.txt"), "utf8")).toBe("DONE\n");
		expect(await readFile(join(tempDir, ".pi", "tasks", "RPC_Fork_Plan.md"), "utf8")).toContain("- [ ]");
	} finally {
		unsubscribe();
		await client.stop();
	}
}, 240000);
