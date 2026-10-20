/// <reference path="../pb_data/types.d.ts" />
// Every lease is exclusive now: one holder per resource at a time. Leases taken as shared
// before this change keep running until they expire; the server no longer tells them apart.
migrate((app) => {
  const c = app.findCollectionByNameOrId("leases")
  c.fields.removeByName("mode")
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("leases")
  c.fields.add(new SelectField({ name: "mode", values: ["shared", "exclusive"], maxSelect: 1 }))
  app.save(c)
})
