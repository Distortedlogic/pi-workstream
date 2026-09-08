import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import fg from "fast-glob";
import writeFileAtomic from "write-file-atomic";
import type { PlanId } from "./model.ts";
import { parsePlan } from "./parser.ts";

export const ERR_PLAN_BINDING = "The bound plan is missing, duplicated, or different.";
export const ERR_PLAN_COLLISION = "A different plan already uses the canonical plan filename.";

export async function loadPlan(path: string) {
	const absolutePath = resolve(path);
	return parsePlan(await readFile(absolutePath, "utf8"), absolutePath);
}

export async function findPlanById(root: string, planId: PlanId) {
	const paths = await fg("**/*.md", { cwd: resolve(root), absolute: true, onlyFiles: true });
	const matches = [];
	for (const path of paths) {
		try {
			const plan = await loadPlan(path);
			if (plan.planId === planId) matches.push(plan);
		} catch {
			// An unrelated invalid Markdown file cannot satisfy a bound plan ID.
		}
	}
	if (matches.length !== 1) throw new Error(ERR_PLAN_BINDING);
	return matches[0];
}

export async function writeCanonicalPlan(root: string, markdown: string) {
	const incoming = parsePlan(markdown);
	const target = join(resolve(root), incoming.canonicalFilename);
	let existing: Awaited<ReturnType<typeof loadPlan>> | undefined;
	try {
		existing = await loadPlan(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing && (existing.title !== incoming.title || existing.planId !== incoming.planId)) {
		throw new Error(ERR_PLAN_COLLISION);
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFileAtomic(target, markdown, { encoding: "utf8" });
	return parsePlan(markdown, target);
}

export async function setTaskChecked(path: string, batchId: string, taskIndex: number, checked: boolean) {
	const plan = await loadPlan(path);
	const batch = plan.batches.find((candidate) => candidate.id === batchId);
	const task = batch?.tasks[taskIndex];
	if (!batch || !task) throw new Error(ERR_PLAN_BINDING);
	const marker = checked ? "x" : " ";
	const markdown = `${plan.markdown.slice(0, task.checkboxOffset)}${marker}${plan.markdown.slice(task.checkboxOffset + 1)}`;
	await writeFileAtomic(path, markdown, { encoding: "utf8" });
	return loadPlan(path);
}
