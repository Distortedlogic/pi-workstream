# pi-workstream

A native Pi extension for disk-backed task plans, isolated H2 batch execution, and reviewed context compression.

## Install

```bash
pi install https://github.com/Distortedlogic/pi-workstream
```

For local development:

```bash
pi -e /path/to/pi-workstream/src/workstream.ts
```

Disable the separate legacy Todo, True Queue, and pipeline Context Tree extensions when pi-workstream replaces them. A second extension that registers `/queue` or `/todos` can shadow this pipeline's commands.

## Workflow

### 1. Create the plan with the planning agent

Start Pi in the target project and ask the agent to write a technical task plan with the normal `write` tool.

Example plan content:

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

The agent can choose any write path. When the write contains a valid task plan, pi-workstream changes the tool path before execution and writes:

```text
.pi/tasks/Add_Health_Endpoint.md
```

The extension derives the filename from the H1. It rejects a different H1 that maps to an occupied filename.

Ask the planning agent to refine the same canonical file with the normal `edit` tool. The H1 cannot change after the first canonical write.

Use `/todos` to show the current plan in the user UI.

### 2. Start a clean execution session

The planning session contains the full future plan. Start a new Pi session before execution so that future batches do not enter execution-agent context:

```text
/new
```

Preload any required source context in this new session.

### 3. Run the plan

```text
/queue run
```

`/queue run` takes no plan path. Exactly one incomplete canonical plan must exist under `.pi/tasks/`.

pi-workstream then:

1. Binds the run to the plan ID.
2. Reads the first incomplete H2 batch.
3. Sends only the shared preamble and that H2 batch to the agent.
4. Waits for Pi's `agent_settled` event.
5. Generates a batch summary and opens it for review.
6. Revalidates the session, plan, revisions, and checkbox bitmap after review.
7. Preserves the exact queued batch message and approved summary in active context.
8. Moves the raw batch execution to an off-path branch.
9. Atomically checks every checkbox in the completed H2 batch.
10. Sends the next incomplete H2 batch automatically.

The loop ends when all batches are checked.

## Review cancellation

If you cancel or save an empty summary:

- The batch stays unchecked.
- No session compression is applied.
- No later batch is sent.
- The next steering turn and `agent_settled` event starts a new review.
- `/queue run` can retry the frozen batch after a reload or restart.

## Plan rules

- Exactly one H1 is required.
- Every H2 is one ordered execution batch.
- Every H2 must contain at least one GFM task checkbox.
- Task checkboxes before the first H2 are rejected.
- H3 and deeper content belongs to its current H2.
- Normal non-task lists are allowed in the preamble.
- Normalized H2 headings must be unique.
- `[x]` and `[X]` are checked.

## Safety rules

- Markdown under `.pi/tasks/` is the task source of truth.
- Future batch titles and bodies are not stored in run state or sent to the execution agent.
- Run state does not persist the plan path, plan title, or task text.
- Plan and session state are checked again after summary review and before mutation.
- Checkbox writes use expected revisions and `write-file-atomic`.
- Missing, duplicated, structurally changed, or stale bound plans pause the run without dispatching another batch.
- Original session entries remain in the append-only session tree.
