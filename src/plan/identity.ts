import { createHash } from "node:crypto";
import slugify from "@sindresorhus/slugify";
import type { BatchId, PlanId } from "./model.ts";

const PLAN_ID_FORMAT = "pi-workstream/plan-id/v1";
const BATCH_ID_FORMAT = "pi-workstream/batch-id/v1";

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalPlanFilename(title: string): string {
	const stem = slugify(title.normalize("NFC"), { decamelize: false, separator: "-" });
	if (!stem) throw new Error("The plan title does not produce a valid filename.");
	return `${stem.toLowerCase()}.md`;
}

/** Full lowercase SHA-256 of a versioned canonical filename representation. */
export function planIdFromFilename(filename: string): PlanId {
	const canonical = filename.normalize("NFC").toLowerCase();
	return sha256(`${PLAN_ID_FORMAT}\u0000${canonical}`);
}

export function batchIdFor(planId: PlanId, title: string): BatchId {
	return sha256(`${BATCH_ID_FORMAT}\u0000${planId}\u0000${title.normalize("NFC")}`);
}
