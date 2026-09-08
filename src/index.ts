import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkstreamCommand } from "./commands.ts";
import { WorkstreamRuntime } from "./engine/runtime.ts";
import { registerWorkstreamTool } from "./tools.ts";

export default function piWorkstream(pi: ExtensionAPI): void {
	const runtime = new WorkstreamRuntime(pi);
	runtime.registerLifecycle();
	registerWorkstreamCommand(pi, runtime);
	registerWorkstreamTool(pi, runtime);
}
