# Architecture

## One extension boundary

`src/index.ts` is the only Pi extension entry point. It registers the Context Tree, Todo, and Queue modules with the same `ExtensionAPI` instance.

## Module ownership

- `context` owns session-tree analysis, context display, and session mutation.
- `todo` owns task state, task replay, the Todo tool, and Todo views.
- `queue` owns deferred execution and queue views.
- `workstream` owns shared plan-run identity and cross-module coordination.

## Integration rule

The final pipeline must use `workstream` as the only owner of run state. The feature modules can read or change that state through explicit domain operations. They must not send private request messages to each other.

## Durable state

The shared run state can contain identifiers, revisions, status, and the current pre-completion checkbox bitmap. It must not contain plan paths, plan titles, task text, future batch text, or future batch bitmaps.

## Safe compression

Context mutation must occur only after a fresh current-batch read matches the accepted plan ID, batch ID, revisions, and checkbox bitmap.
