// Tiny event bus so side effects (thumbnails, later notifications, …) hang off
// generation events instead of being hard-wired into the runner.
//
//   generation:finished  { instance, outputPath }   a clip was downloaded and recorded as done
//   prod:cached          { instance, filePath }     the production clip was archived locally
//   run:finished         { runId, summary }

const handlers = new Map()

export const on = (event, handler) => {
  if (!handlers.has(event)) handlers.set(event, new Set())
  handlers.get(event).add(handler)
  return () => handlers.get(event).delete(handler)
}

/** Runs every handler; a failing handler is logged and never breaks the emitter. */
export const emit = async (event, payload) => {
  for (const handler of handlers.get(event) || []) {
    try {
      await handler(payload)
    } catch (err) {
      console.error(`[hook ${event}] ${err.message}`)
    }
  }
}
