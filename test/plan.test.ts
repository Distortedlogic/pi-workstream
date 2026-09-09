import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeBatch, hash, incompletePlan, parsePlan, savePlan, snapshot, validatePlanEdits } from "../src/plan.ts";

const roots: string[] = [];

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-workstream-plan-"));
	roots.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("disk-backed task plans", () => {
	it("derives the canonical filename, plan ID, batch IDs, revisions, and ordered bitmaps", () => {
		const markdown = [
			"# Release Plan",
			"",
			"A normal preamble paragraph.",
			"",
			"##   Build   Artifacts ",
			"",
			"- [x] Compile",
			"- [ ] Package",
			"",
			"## Ship",
			"",
			"- [ ] Publish",
		].join("\n");
		const plan = parsePlan(markdown);
		const statusOnlyChange = parsePlan(markdown.replace("- [ ] Package", "- [X] Package"));

		expect(plan.filename).toBe("Release_Plan.md");
		expect(plan.id).toBe(hash(JSON.stringify({ version: 1, filename: "Release_Plan.md" })));
		expect(plan.preamble).toBe("# Release Plan\n\nA normal preamble paragraph.");
		expect(plan.batches.map((batch) => batch.id)).toEqual([hash("build artifacts"), hash("ship")]);
		expect(plan.batches[0].markdown).not.toContain("## Ship");
		expect(plan.batches.map((batch) => snapshot(plan, batch).bitmap)).toEqual([[true, false], [false]]);
		expect(statusOnlyChange.structuralRevision).toBe(plan.structuralRevision);
		expect(statusOnlyChange.fileRevision).not.toBe(plan.fileRevision);
	});

	it.each([
		{
			name: "a task before the first batch",
			markdown: "# Plan\n\n- [ ] outside\n\n## Batch\n\n- [ ] inside\n",
			error: "Plan task checkboxes must be inside a level-two batch.",
		},
		{
			name: "a batch without a task checkbox",
			markdown: "# Plan\n\n## Empty\n\nNo task.\n\n## Work\n\n- [ ] task\n",
			error: "Every level-two batch must contain at least one task checkbox.",
		},
		{
			name: "normalized duplicate batch headings",
			markdown: "# Plan\n\n## Build Work\n\n- [ ] one\n\n##  build   work \n\n- [ ] two\n",
			error: "Plan batch headings must be unique.",
		},
		{
			name: "more than one plan heading",
			markdown: "# One\n\n## Batch\n\n- [ ] task\n\n# Two\n",
			error: "The plan must contain exactly one level-one heading.",
		},
	])("rejects $name", ({ markdown, error }) => {
		expect(() => parsePlan(markdown)).toThrow(error);
	});

	it("accepts a non-task preamble list and assigns nested checkboxes to the current H2", () => {
		const plan = parsePlan(
			"# Plan\n\n- context\n- constraints\n\n## Batch\n\n- [ ] task\n  - [ ] nested acceptance check\n",
		);
		expect(plan.batches[0].tasks.map((task) => task.text)).toEqual(["task", "nested acceptance check"]);
	});

	it("rejects a distinct H1 that maps to an occupied canonical filename without changing the file", async () => {
		const directory = await root();
		const original = "# A:B\n\n## Batch\n\n- [ ] one\n";
		const stored = await savePlan(original, directory);

		await expect(savePlan("# AB\n\n## Batch\n\n- [ ] two\n", directory)).rejects.toThrow(
			"A different plan already uses the canonical task-plan filename.",
		);
		expect(await readFile(stored.path, "utf8")).toBe(original);
	});

	it("permits same-H1 refinement at the same canonical path and rejects an H1 edit", async () => {
		const directory = await root();
		const first = await savePlan("# Refine Plan\n\n## Batch\n\n- [ ] first\n", directory);
		const refined = await savePlan(
			"# Refine Plan\n\nUpdated rules.\n\n## Batch\n\n- [ ] first\n- [ ] second\n",
			directory,
		);

		expect(refined.path).toBe(first.path);
		expect(refined.id).toBe(first.id);
		await expect(
			validatePlanEdits(refined.path, [{ oldText: "# Refine Plan", newText: "# Renamed Plan" }]),
		).rejects.toThrow("A task plan level-one heading cannot change");
	});

	it("selects exactly one incomplete plan and ignores a completed plan", async () => {
		const directory = await root();
		const first = await savePlan("# First Plan\n\n## Batch\n\n- [ ] first\n", directory);
		const second = await savePlan("# Second Plan\n\n## Batch\n\n- [ ] second\n", directory);
		await expect(incompletePlan(directory)).rejects.toThrow("More than one incomplete task plan exists.");

		await completeBatch(first, snapshot(first, first.batches[0]));
		expect((await incompletePlan(directory)).id).toBe(second.id);
		await completeBatch(second, snapshot(second, second.batches[0]));
		await expect(incompletePlan(directory)).rejects.toThrow("There is no incomplete task plan to run.");
	});

	it("atomically completes the whole expected batch and does not change a future batch", async () => {
		const directory = await root();
		const plan = await savePlan(
			"# Exact Completion\n\n## First\n\n- [x] already done\n- [ ] finish now\n\n## Future\n\n- [ ] keep hidden\n",
			directory,
		);
		const completed = await completeBatch(plan, snapshot(plan, plan.batches[0]));

		expect(await readFile(plan.path, "utf8")).toBe(
			"# Exact Completion\n\n## First\n\n- [x] already done\n- [x] finish now\n\n## Future\n\n- [ ] keep hidden\n",
		);
		expect(snapshot(completed, completed.batches[0]).bitmap).toEqual([true, true]);
		expect(snapshot(completed, completed.batches[1]).bitmap).toEqual([false]);
	});

	it("rejects a stale batch completion without overwriting the changed file", async () => {
		const directory = await root();
		const plan = await savePlan("# Stale Completion\n\n## Batch\n\n- [ ] task\n", directory);
		const changed = "# Stale Completion\n\nNew rule.\n\n## Batch\n\n- [ ] task\n";
		await writeFile(plan.path, changed, "utf8");

		await expect(completeBatch(plan, snapshot(plan, plan.batches[0]))).rejects.toThrow(
			"The current plan batch changed before completion.",
		);
		expect(await readFile(plan.path, "utf8")).toBe(changed);
	});
});
