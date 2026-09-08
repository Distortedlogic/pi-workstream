import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTask, parsePlan, savePlan, snapshot } from "../src/plan.ts";

const roots: string[] = [];

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-workstream-plan-"));
	roots.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workstream plans", () => {
	it("derives stable plan and batch identity with ordered checkbox state", () => {
		const markdown = [
			"# Release Plan",
			"",
			"A normal preamble paragraph.",
			"",
			"## Build",
			"",
			"- [x] Compile",
			"- [ ] Package",
			"",
			"## Ship",
			"",
			"- [ ] Publish",
		].join("\n");
		const first = parsePlan(markdown);
		const second = parsePlan(markdown);

		expect(first.id).toMatch(/^[a-f0-9]{64}$/);
		expect(first.id).toBe(second.id);
		expect(first.filename).toBe("release-plan.md");
		expect(first.batches.map((batch) => batch.title)).toEqual(["Build", "Ship"]);
		expect(first.batches.map((batch) => batch.id)).toEqual(second.batches.map((batch) => batch.id));
		expect(snapshot(first, first.batches[0]).bitmap).toEqual([true, false]);
		expect(snapshot(first, first.batches[1]).bitmap).toEqual([false]);
	});

	it.each([
		{
			name: "a task before the first batch",
			markdown: "# Plan\n\n- [ ] outside\n\n## Batch\n\n- [ ] inside\n",
			error: "Plan task checkboxes must be inside a level-two batch.",
		},
		{
			name: "duplicate batch headings",
			markdown: "# Plan\n\n## Batch\n\n- [ ] one\n\n## Batch\n\n- [ ] two\n",
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

	it("accepts a non-task preamble list", () => {
		const plan = parsePlan("# Plan\n\n- context\n- constraints\n\n## Batch\n\n- [ ] task\n");
		expect(plan.batches).toHaveLength(1);
		expect(plan.batches[0].tasks.map((task) => task.text)).toEqual(["task"]);
	});

	it("rejects distinct headings that map to the same canonical filename", async () => {
		const directory = await root();
		await savePlan("# A/B\n\n## Batch\n\n- [ ] one\n", directory);
		await expect(savePlan("# A B\n\n## Batch\n\n- [ ] two\n", directory)).rejects.toThrow(
			"A different plan already uses the canonical plan filename.",
		);
	});

	it("changes only the selected checkbox", async () => {
		const directory = await root();
		const plan = await savePlan("# Exact Write\n\n## Batch\n\n- [ ] first\n- [ ] second\n", directory);
		const updated = await checkTask(plan, plan.batches[0].id, 1);

		expect(await readFile(plan.path, "utf8")).toBe("# Exact Write\n\n## Batch\n\n- [ ] first\n- [x] second\n");
		expect(snapshot(updated, updated.batches[0]).bitmap).toEqual([false, true]);
	});
});
