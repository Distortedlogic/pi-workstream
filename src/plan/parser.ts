import type { Heading, ListItem, Paragraph, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { batchIdFor, canonicalPlanFilename, planIdFromFilename, sha256 } from "./identity.ts";
import type { PlanBatch, PlanDocument, PlanTask } from "./model.ts";

export const ERR_PLAN_H1 = "The plan must contain exactly one level-one heading.";
export const ERR_PLAN_BATCHES = "The plan must contain at least one level-two batch.";
export const ERR_TASK_OUTSIDE_BATCH = "Plan task checkboxes must be inside a level-two batch.";
export const ERR_DUPLICATE_BATCH = "Plan batch headings must be unique.";
export const ERR_TASK_POSITION = "A plan task checkbox has no stable source position.";

interface MutableBatch {
	index: number;
	title: string;
	tasks: PlanTask[];
}

function taskText(item: ListItem): string {
	const paragraph = item.children.find((child): child is Paragraph => child.type === "paragraph");
	return toString(paragraph ?? item).trim();
}

function checkboxOffset(markdown: string, item: ListItem): number {
	const start = item.position?.start.offset;
	const end = item.position?.end.offset;
	if (start === undefined || end === undefined) throw new Error(ERR_TASK_POSITION);
	const source = markdown.slice(start, end);
	const match = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/m.exec(source);
	if (!match || match.index === undefined) throw new Error(ERR_TASK_POSITION);
	return start + match.index + match[0].lastIndexOf("[") + 1;
}

export function parsePlan(markdown: string, path = ""): PlanDocument {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
	const h1: Heading[] = [];
	const batches: MutableBatch[] = [];
	let currentBatch: MutableBatch | undefined;

	visit(tree, (node) => {
		if (node.type === "heading") {
			const heading = node as Heading;
			if (heading.depth === 1) h1.push(heading);
			if (heading.depth === 2) {
				currentBatch = { index: batches.length, title: toString(heading).trim(), tasks: [] };
				batches.push(currentBatch);
			}
			return;
		}
		if (node.type !== "listItem") return;
		const item = node as ListItem;
		if (typeof item.checked !== "boolean") return;
		if (!currentBatch) throw new Error(ERR_TASK_OUTSIDE_BATCH);
		currentBatch.tasks.push({
			index: currentBatch.tasks.length,
			text: taskText(item),
			checked: item.checked,
			checkboxOffset: checkboxOffset(markdown, item),
		});
	});

	if (h1.length !== 1) throw new Error(ERR_PLAN_H1);
	if (batches.length === 0) throw new Error(ERR_PLAN_BATCHES);
	const title = toString(h1[0]).trim();
	const canonicalFilename = canonicalPlanFilename(title);
	const planId = planIdFromFilename(canonicalFilename);
	const seenBatchTitles = new Set<string>();
	const planBatches: PlanBatch[] = batches.map((batch) => {
		const canonicalTitle = batch.title.normalize("NFC");
		if (seenBatchTitles.has(canonicalTitle)) throw new Error(ERR_DUPLICATE_BATCH);
		seenBatchTitles.add(canonicalTitle);
		return {
			id: batchIdFor(planId, canonicalTitle),
			index: batch.index,
			title: batch.title,
			tasks: batch.tasks,
			checkboxBitmap: batch.tasks.map((task) => task.checked),
		};
	});
	const structure = {
		v: 1,
		title: title.normalize("NFC"),
		batches: planBatches.map((batch) => ({
			id: batch.id,
			title: batch.title.normalize("NFC"),
			tasks: batch.tasks.map((task) => task.text.normalize("NFC")),
		})),
	};
	return {
		path,
		markdown,
		title,
		canonicalFilename,
		planId,
		fileRevision: sha256(markdown),
		structuralRevision: sha256(`pi-workstream/plan-structure/v1\u0000${JSON.stringify(structure)}`),
		batches: planBatches,
	};
}
