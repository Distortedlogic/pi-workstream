import { createHash } from "node:crypto";
import { glob, mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Heading, ListItem, Paragraph, Root } from "mdast";
import { toString as mdastText } from "mdast-util-to-string";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { Type } from "typebox";
import { visit } from "unist-util-visit";
import writeFileAtomic from "write-file-atomic";

export const planRoot = (cwd: string): string => resolve(cwd, ".pi", "tasks");
export const ERR_PLAN_BINDING = "The bound plan is missing, duplicated, or different.";
export const ERR_NO_PLAN = "There is no incomplete task plan to run.";
export const ERR_MULTIPLE_PLANS = "More than one incomplete task plan exists.";
export const ERR_PLAN_COLLISION = "A different plan already uses the canonical task-plan filename.";

export interface Task {
	text: string;
	checked: boolean;
	checkboxOffset: number;
}

export interface Batch {
	id: string;
	title: string;
	markdown: string;
	tasks: Task[];
}

export interface Plan {
	path: string;
	markdown: string;
	title: string;
	filename: string;
	id: string;
	preamble: string;
	fileRevision: string;
	structuralRevision: string;
	batches: Batch[];
}

export interface TextEdit {
	oldText: string;
	newText: string;
}

export const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export interface BatchSnapshot {
	planId: string;
	batchId: string;
	structuralRevision: string;
	fileRevision: string;
	bitmap: boolean[];
}

export const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function canonicalFilename(title: string): string {
	const stem = title
		.normalize("NFC")
		.trim()
		.replace(/\s+/gu, "_")
		.replace(/[^\p{L}\p{N}_-]/gu, "")
		.replace(/_+/gu, "_");
	if (!stem) throw new Error("The plan title does not produce a valid filename.");
	return `${stem}.md`;
}

function planId(filename: string): string {
	return hash(JSON.stringify({ version: 1, filename: filename.normalize("NFC") }));
}

function normalizedHeading(title: string): string {
	return title.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function taskText(item: ListItem): string {
	const paragraph = item.children.find((child): child is Paragraph => child.type === "paragraph");
	return mdastText(paragraph ?? item).trim();
}

function checkboxOffset(markdown: string, item: ListItem): number {
	const start = item.position?.start.offset;
	const end = item.position?.end.offset;
	if (start === undefined || end === undefined) throw new Error("A plan task has no stable source position.");
	const match = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/m.exec(markdown.slice(start, end));
	if (!match) throw new Error("A plan task has no stable source position.");
	return start + match.index + match[0].lastIndexOf("[") + 1;
}

export function parsePlan(markdown: string, path = ""): Plan {
	const tree = remark().use(remarkGfm).parse(markdown) as Root;
	const h1s: Heading[] = [];
	const h2s: Heading[] = [];
	const batches: Array<Omit<Batch, "markdown">> = [];
	let current: Omit<Batch, "markdown"> | undefined;

	visit(tree, (node) => {
		if (node.type === "heading") {
			const heading = node as Heading;
			if (heading.depth === 1) h1s.push(heading);
			if (heading.depth === 2) {
				h2s.push(heading);
				current = { id: "", title: mdastText(heading).trim(), tasks: [] };
				batches.push(current);
			}
			return;
		}
		if (node.type !== "listItem") return;
		const item = node as ListItem;
		if (typeof item.checked !== "boolean") return;
		if (!current) throw new Error("Plan task checkboxes must be inside a level-two batch.");
		current.tasks.push({
			text: taskText(item),
			checked: item.checked,
			checkboxOffset: checkboxOffset(markdown, item),
		});
	});

	if (h1s.length !== 1) throw new Error("The plan must contain exactly one level-one heading.");
	if (batches.length === 0) throw new Error("The plan must contain at least one level-two batch.");
	if (batches.some((batch) => batch.tasks.length === 0)) {
		throw new Error("Every level-two batch must contain at least one task checkbox.");
	}

	const title = mdastText(h1s[0]).trim();
	const filename = canonicalFilename(title);
	const id = planId(filename);
	const seen = new Set<string>();
	const completeBatches: Batch[] = batches.map((batch, index) => {
		const normalized = normalizedHeading(batch.title);
		if (!normalized || seen.has(normalized)) throw new Error("Plan batch headings must be unique.");
		seen.add(normalized);
		const start = h2s[index]?.position?.start.offset;
		const end = h2s[index + 1]?.position?.start.offset ?? markdown.length;
		if (start === undefined) throw new Error("A plan batch has no stable source position.");
		return {
			...batch,
			id: hash(normalized),
			markdown: markdown.slice(start, end).trimEnd(),
		};
	});
	const firstBatchOffset = h2s[0]?.position?.start.offset;
	if (firstBatchOffset === undefined) throw new Error("A plan batch has no stable source position.");
	const preamble = markdown.slice(0, firstBatchOffset).trimEnd();
	let statusNeutralMarkdown = markdown;
	for (const task of completeBatches
		.flatMap((batch) => batch.tasks)
		.sort((left, right) => right.checkboxOffset - left.checkboxOffset)) {
		statusNeutralMarkdown = `${statusNeutralMarkdown.slice(0, task.checkboxOffset)} ${statusNeutralMarkdown.slice(task.checkboxOffset + 1)}`;
	}
	const structuralValue = {
		version: 1,
		title: title.normalize("NFC"),
		preamble: preamble.normalize("NFC"),
		batches: completeBatches.map((batch, index) => {
			const bodyStart = h2s[index]?.position?.end.offset;
			const bodyEnd = h2s[index + 1]?.position?.start.offset ?? markdown.length;
			if (bodyStart === undefined) throw new Error("A plan batch has no stable source position.");
			return {
				heading: normalizedHeading(batch.title),
				body: statusNeutralMarkdown.slice(bodyStart, bodyEnd).normalize("NFC"),
			};
		}),
	};
	return {
		path,
		markdown,
		title,
		filename,
		id,
		preamble,
		fileRevision: hash(markdown),
		structuralRevision: hash(JSON.stringify(structuralValue)),
		batches: completeBatches,
	};
}

export function tryParsePlan(markdown: string): Plan | undefined {
	try {
		return parsePlan(markdown);
	} catch {
		return undefined;
	}
}

export async function loadPlan(path: string): Promise<Plan> {
	const absolute = resolve(path);
	return parsePlan(await readFile(absolute, "utf8"), absolute);
}

export async function listPlans(root: string): Promise<Plan[]> {
	await mkdir(root, { recursive: true });
	const plans: Plan[] = [];
	for await (const relativePath of glob("**/*.md", { cwd: root })) {
		plans.push(await loadPlan(resolve(root, relativePath)));
	}
	return plans;
}

export async function findPlan(id: string, root: string): Promise<Plan> {
	const matches = (await listPlans(root)).filter((plan) => plan.id === id);
	if (matches.length !== 1) throw new Error(ERR_PLAN_BINDING);
	return matches[0];
}

export async function incompletePlan(root: string): Promise<Plan> {
	const plans = (await listPlans(root)).filter((plan) => firstIncompleteBatch(plan));
	if (plans.length === 0) throw new Error(ERR_NO_PLAN);
	if (plans.length !== 1) throw new Error(ERR_MULTIPLE_PLANS);
	return plans[0];
}

export async function preparePlanWrite(markdown: string, root: string): Promise<Plan> {
	const incoming = parsePlan(markdown);
	await mkdir(root, { recursive: true });
	const target = join(root, incoming.filename);
	try {
		const existing = await loadPlan(target);
		if (
			existing.title !== incoming.title ||
			existing.id !== incoming.id ||
			basename(existing.path) !== incoming.filename
		) {
			throw new Error(ERR_PLAN_COLLISION);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { ...incoming, path: target };
}

export async function savePlan(markdown: string, root: string): Promise<Plan> {
	const plan = await preparePlanWrite(markdown, root);
	await writeFileAtomic(plan.path, markdown, { encoding: "utf8" });
	return loadPlan(plan.path);
}

export function previewEdits(markdown: string, edits: readonly TextEdit[]): string {
	const replacements = edits.map((edit) => {
		if (!edit.oldText) throw new Error("A plan edit cannot match empty text.");
		const start = markdown.indexOf(edit.oldText);
		if (start === -1 || markdown.indexOf(edit.oldText, start + 1) !== -1) {
			throw new Error("A plan edit must match exactly once.");
		}
		return { ...edit, start, end: start + edit.oldText.length };
	});
	const ordered = [...replacements].sort((left, right) => left.start - right.start);
	if (ordered.some((edit, index) => index > 0 && edit.start < ordered[index - 1].end)) {
		throw new Error("Plan edits cannot overlap.");
	}
	let result = markdown;
	for (const edit of ordered.reverse()) {
		result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
	}
	return result;
}

export async function validatePlanEdits(path: string, edits: readonly TextEdit[]): Promise<Plan> {
	const current = await loadPlan(path);
	const candidate = parsePlan(previewEdits(current.markdown, edits), current.path);
	if (candidate.title !== current.title || candidate.filename !== current.filename || candidate.id !== current.id) {
		throw new Error("A task plan level-one heading cannot change after its first canonical write.");
	}
	return candidate;
}

export async function completeBatch(plan: Plan, expected: BatchSnapshot): Promise<Plan> {
	const fresh = await loadPlan(plan.path);
	const batch = batchById(fresh, expected.batchId);
	if (!batch || !sameSnapshot(expected, snapshot(fresh, batch))) {
		throw new Error("The current plan batch changed before completion.");
	}
	let markdown = fresh.markdown;
	for (const task of [...batch.tasks].sort((left, right) => right.checkboxOffset - left.checkboxOffset)) {
		if (task.checked) continue;
		markdown = `${markdown.slice(0, task.checkboxOffset)}x${markdown.slice(task.checkboxOffset + 1)}`;
	}
	await writeFileAtomic(fresh.path, markdown, { encoding: "utf8" });
	const completed = await loadPlan(fresh.path);
	const completedBatch = batchById(completed, expected.batchId);
	if (
		!completedBatch ||
		completed.structuralRevision !== expected.structuralRevision ||
		completedBatch.tasks.some((task) => !task.checked)
	) {
		throw new Error("The task plan batch completion could not be verified.");
	}
	return completed;
}

export const batchById = (plan: Plan, batchId: string): Batch | undefined =>
	plan.batches.find((batch) => batch.id === batchId);

export const firstIncompleteBatch = (plan: Plan): Batch | undefined =>
	plan.batches.find((batch) => batch.tasks.some((task) => !task.checked));

export function snapshot(plan: Plan, batch: Batch): BatchSnapshot {
	return {
		planId: plan.id,
		batchId: batch.id,
		structuralRevision: plan.structuralRevision,
		fileRevision: plan.fileRevision,
		bitmap: batch.tasks.map((task) => task.checked),
	};
}

export function sameSnapshot(left: BatchSnapshot, right: BatchSnapshot): boolean {
	return (
		left.planId === right.planId &&
		left.batchId === right.batchId &&
		left.structuralRevision === right.structuralRevision &&
		left.fileRevision === right.fileRevision &&
		sameBitmap(left.bitmap, right.bitmap)
	);
}

export const sameBitmap = (left: readonly boolean[], right: readonly boolean[]): boolean =>
	left.length === right.length && left.every((checked, index) => checked === right[index]);
