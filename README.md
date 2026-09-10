# pi-workstream

One native Pi extension for disk-backed planning, isolated H2 batch execution, and reviewed context compression. Tested with Pi `0.84.3`.

## Install

```bash
pi install https://github.com/Distortedlogic/pi-workstream
```

For local development:

```bash
pi -e /path/to/pi-workstream/src/workstream.ts
```

Do not load another extension that registers `/workstream` or `/todos` in the same session.

## 1. Build context and record the planning checkpoint

Start Pi in the target project. Give the agent the work request and let it read the required source files. Ask it to stop before planning.

When context building is complete, run:

```text
/workstream plan
```

This command requires Pi to be idle with no pending messages. It records the current settled entry as the execution base and enters planning state.

It does not open an editor, send a planning prompt, or create a plan itself. Repeated calls keep the original checkpoint.

**Checkpoint placement determines which context execution retains.** Record it after the useful source reads and before discussion or writes that contain the full future plan. The extension does not remove plan content that was already present before the checkpoint.

## 2. Create and refine the plan

Ask the planning agent to write the technical task plan with Pi's normal `write` tool. For example:

```markdown
# Add Health Endpoint

Follow the existing service conventions.

## Implement

- [ ] Add the health endpoint and response type.
- [ ] Update the API documentation.

## Verify

- [ ] Run the existing checks and fix failures.
- [ ] Review the final diff for unrelated changes.
```

During planning, the extension validates a task-plan write and redirects it to the H1-derived canonical path:

```text
.pi/tasks/Add_Health_Endpoint.md
```

The first successful write binds the checkpoint to that plan ID. A failed write does not establish a binding. A different H1 that maps to an occupied filename is rejected without changing the existing file.

Ask the agent to refine the same canonical file with the normal `edit` tool. The H1 and bound identity cannot change. Refinement does not move the checkpoint.

Outside planning state, ordinary writes are not redirected into the plan store. During execution, direct plan writes and edits are blocked.

Use `/todos` to inspect the plan in the user UI.

## 3. Approve, fork, and execute

When the plan is ready, run:

```text
/workstream run
```

This command takes no path. On the planning branch it:

1. Validates the recorded source session and checkpoint.
2. Resolves the bound plan and captures its current revisions and batch bitmap.
3. Creates a native Pi fork at the checkpoint, including that entry.
4. Leaves the original planning session unchanged.
5. Revalidates the approved plan in the replacement session.
6. Persists the new run state and sends the first incomplete H2 batch automatically.

The fork keeps the source reads and context built before the checkpoint. It excludes later planning discussion, full-plan writes, and refinements. No blank session or second startup command is needed.

Other plans do not replace the explicit planning binding.

## Automatic batch loop

The execution agent receives only the shared preamble and current H2 batch.

At Pi's `agent_settled` event, the extension drafts a summary and opens the review editor automatically. After you save a non-empty summary, it:

1. Revalidates the plan, session, revisions, and checkbox bitmap.
2. Preserves the exact queued batch text and approved summary in active context.
3. Moves raw batch execution off the active branch without deleting original entries.
4. Atomically checks the completed batch in the Markdown plan.
5. Dispatches the next incomplete H2 batch.

The run completes when no incomplete batch remains. The final plan binding stays recoverable.

## Cancellation and recovery

- A cancelled fork leaves the planning session and plan unchanged.
- A changed approved snapshot stops destination startup without sending a batch.
- Planning checkpoints and bindings survive reload and restart.
- `/workstream run` on an execution fork resumes its saved run; it does not fork again.
- Cancelling summary review keeps the batch unchecked and sends no later batch.
- A later steering turn can start another review. `/workstream run` can also retry the saved range.
- Missing, duplicate, or changed bound plans stop advancement. The extension does not select another plan as a fallback.

## Plan and persistence rules

- Exactly one H1 is required.
- Every H2 is one ordered batch with at least one GFM task checkbox.
- Task checkboxes before the first H2 are rejected.
- H3 and deeper content belongs to the current H2.
- Non-task preamble lists are allowed.
- Normalized H2 headings must be unique.
- `[x]` and `[X]` are checked.
- Markdown under `.pi/tasks/` is the task source of truth.
- Durable state stores IDs, revisions, current-batch bitmaps, and session boundaries—not plan paths, titles, task text, or future batches.
- The full plan is available through user-only TUI output, not execution-agent messages.

## Validation

```bash
npm run check
npm test
npm run test:e2e
```

`npm test` runs unit tests and integration tests on the real Pi runtime with deterministic model responses. `npm run test:e2e` uses the real configured model and its normal authentication.
