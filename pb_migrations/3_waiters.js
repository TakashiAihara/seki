/// <reference path="../pb_data/types.d.ts" />
// Callers waiting for a resource, in arrival order (queued_at, Unix ms). A waiter
// expires like a lease: the waiting client keeps asking, and one that stops falls
// out of the queue instead of blocking it.
migrate((app) => {
  const c = new Collection({
    type: "base",
    name: "waiters",
    fields: [
      { name: "resource", type: "text", required: true },
      { name: "holder", type: "text", required: true },
      { name: "host", type: "text" },
      { name: "why", type: "text" },
      { name: "queued_at", type: "number", required: true },
      { name: "expires_at", type: "number", required: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_waiters_res_holder ON waiters (resource, holder)"],
  })
  app.save(c)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("waiters"))
})
