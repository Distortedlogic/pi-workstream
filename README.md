# pi-workstream

`pi-workstream` is one native Pi extension for controlled work execution and context management.

It starts with working code from three MIT-licensed extensions:

- **pi-context-tree**: branches, merges, crop, range compression, context status, and the context panel.
- **rpiv-todo**: the `todo` tool, `/todos`, durable task replay, and the Todo overlay.
- **pi-true-queue**: deferred task execution, queue directives, `/queue`, and the queue editor.

The long-term integration will use one run state for plan identity, ordered batches, queue progress, review, and context compression.

## Development

Requirements:

- Node.js 22.19 or later
- npm 11 or later

Install and check the extension:

```sh
npm install
npm run check
```

Load it from the repository:

```sh
pi -e ./src/index.ts
```

## Included commands and tools

### Context

- `/branch`
- `/merge`
- `/crop`
- `/compress`
- `/panel`
- `/decisions`
- `/undo`
- `Ctrl+Q`: open the context panel

### Todo

- `todo` tool
- `/todos`
- `Ctrl+Shift+T`: collapse or expand the Todo overlay by default

### Queue

- `enqueue_task` tool
- `/queue`
- `Ctrl+Shift+Q`: open the queue editor

The queue shortcut differs from pi-true-queue because Context Tree already uses `Ctrl+Q`.

## Source layout

- `packages/core/`: matching Context Tree domain library
- `packages/tui/`: matching Context Tree interface library
- `src/context/`: Context Tree extension layer
- `src/todo/`: Todo state, tool, view, locale, and overlay modules
- `src/queue/`: queue runtime and editor
- `src/workstream/`: shared integration state and future pipeline coordination
- `src/index.ts`: the one Pi extension entry point
- `skills/`: the queue task-isolation skill

## Status

This first scaffold preserves the three working feature sets in one private repository. The shared plan-to-queue-to-compression pipeline is the next implementation stage.

See `THIRD_PARTY_NOTICES.md` for source and license details.
