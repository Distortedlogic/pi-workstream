import { hash as nodeHash } from "node:crypto";
import { glob, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import slugify from "@sindresorhus/slugify";
import type { Heading, ListItem, Paragraph, Root } from "mdast";
import { toString as mdastText } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type Static, Type } from "typebox";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import writeFileAtomic from "write-file-atomic";

export const planRoot = (cwd: string): string => resolve(cwd, ".pi", "plans");
export const ERR_PLAN_BINDING = "The bound plan is missing, duplicated, or different.";
const ID_FORMAT = "pi-workstream/id/v1";

export interface Task {
	text: string;
	checked: boolean;
	checkboxOffset: number;
}

export interface Batch {
	id: string;
	title: string;
	tasks: Task[];
}

export interface Plan {
	path: string;
	markdown: string;
	title: string;
	filename: string;
	id: string;
	fileRevision: string;
	structuralRevision: string;
	batches: Batch[];
}

export const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const BatchSnapshotSchema = Type.Object(
	{
		planId: Sha256Schema,
		batchId: Sha256Schema,
		structuralRevision: Sha256Schema,
		fileRevision: Sha256Schema,
		bitmap: Type.Array(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type BatchSnapshot = Static<typeof BatchSnapshotSchema>;

export const hash = (value: string): string => nodeHash("sha256", value, "hex");

function filename(title: string): string {
	const stem = slugify(title.normalize("NFC"), { decamelize: false, separator: "-" });
	if (!stem) throw new Error("The plan title does not produce a valid filename.");
	return `${stem.toLowerCase()}.md`;
}

function id(kind: "plan" | "batch", value: string): string {
	return hash(`${ID_FORMAT}\u0000${kind}\u0000${value.normalize("NFC")}`);
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
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
	const headings: Heading[] = [];
	const batches: Batch[] = [];
	let current: Batch | undefined;

	visit(tree, (node) => {
		if (node.type === "heading") {
			const heading = node as Heading;
			if (heading.depth === 1) headings.push(heading);
			if (heading.depth === 2) {
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

	if (headings.length !== 1) throw new Error("The plan must contain exactly one level-one heading.");
	if (batches.length === 0) throw new Error("The plan must contain at least one level-two batch.");
	const title = mdastText(headings[0]).trim();
	const canonicalFilename = filename(title);
	const planId = id("plan", canonicalFilename);
	const seen = new Set<string>();
	for (const batch of batches) {
		const canonicalTitle = batch.title.normalize("NFC");
		if (seen.has(canonicalTitle)) throw new Error("Plan batch headings must be unique.");
		seen.add(canonicalTitle);
		batch.id = id("batch", `${planId}\u0000${canonicalTitle}`);
	}
	const structure = batches.map((batch) => ({
		id: batch.id,
		title: batch.title.normalize("NFC"),
		tasks: batch.tasks.map((task) => task.text.normalize("NFC")),
	}));
	return {
		path,
		markdown,
		title,
		filename: canonicalFilename,
		id: planId,
		fileRevision: hash(markdown),
		structuralRevision: hash(`pi-workstream/structure/v1\u0000${JSON.stringify({ title, structure })}`),
		batches,
	};
}

export async function loadPlan(path: string): Promise<Plan> {
	const absolute = resolve(path);
	return parsePlan(await readFile(absolute, "utf8"), absolute);
}

export async function findPlan(planId: string, root: string): Promise<Plan> {
	const matches: Plan[] = [];
	for await (const relativePath of glob("**/*.md", { cwd: root })) {
		try {
			const plan = await loadPlan(resolve(root, relativePath));
			if (plan.id === planId) matches.push(plan);
		} catch {}
	}
	if (matches.length !== 1) throw new Error(ERR_PLAN_BINDING);
	return matches[0];
}

export async function savePlan(markdown: string, root: string): Promise<Plan> {
	const incoming = parsePlan(markdown);
	const target = join(root, incoming.filename);
	let existing: Plan | undefined;
	try {
		existing = await loadPlan(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing && (existing.title !== incoming.title || existing.id !== incoming.id)) {
		throw new Error("A different plan already uses the canonical plan filename.");
	}
	await mkdir(root, { recursive: true });
	await writeFileAtomic(target, markdown, { encoding: "utf8" });
	return parsePlan(markdown, target);
}

export async function checkTask(plan: Plan, batchId: string, taskIndex: number): Promise<Plan> {
	const fresh = await loadPlan(plan.path);
	const task = fresh.batches.find((batch) => batch.id === batchId)?.tasks[taskIndex];
	if (!task) throw new Error(ERR_PLAN_BINDING);
	const markdown = `${fresh.markdown.slice(0, task.checkboxOffset)}x${fresh.markdown.slice(task.checkboxOffset + 1)}`;
	await writeFileAtomic(fresh.path, markdown, { encoding: "utf8" });
	return loadPlan(fresh.path);
}

export const batchById = (plan: Plan, batchId: string): Batch | undefined =>
	plan.batches.find((batch) => batch.id === batchId);

export const firstIncompleteBatch = (plan: Plan): Batch | undefined =>
	plan.batches.find((batch) => batch.tasks.some((task) => !task.checked));

export function nextIncompleteBatch(plan: Plan, batchId: string): Batch | undefined {
	const current = plan.batches.findIndex((batch) => batch.id === batchId);
	return current === -1
		? undefined
		: plan.batches.slice(current + 1).find((batch) => batch.tasks.some((task) => !task.checked));
}

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
