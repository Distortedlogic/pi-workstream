import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerContextTree from "./context/index.ts";
import registerQueue from "./queue/index.ts";
import registerTodo from "./todo/index.ts";

/** Register the complete plan, queue, todo, and context workstream. */
export default function registerPiWorkstream(pi: ExtensionAPI): void {
	registerTodo(pi);
	registerQueue(pi);
	registerContextTree(pi);
}
