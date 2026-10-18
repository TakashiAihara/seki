/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const c = new Collection({
    type: "base",
    name: "leases",
    fields: [
      { name: "resource", type: "text", required: true },
      { name: "holder", type: "text", required: true },
      { name: "mode", type: "select", values: ["shared", "exclusive"], maxSelect: 1, required: true },
      { name: "host", type: "text" },
      { name: "why", type: "text" },
      { name: "expires_at", type: "number", required: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_leases_res_holder ON leases (resource, holder)"],
  })
  app.save(c)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("leases"))
})
