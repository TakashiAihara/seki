/// <reference path="../pb_data/types.d.ts" />
// Every lease is exclusive now: one holder per resource at a time. Shared co-holders left from
// before keep renewing (the server lets a holder renew its own lease whoever else holds the
// resource) and block everyone else until the last of them lets go.
migrate((app) => {
  const c = app.findCollectionByNameOrId("leases")
  c.fields.removeByName("mode")
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("leases")
  c.fields.add(new SelectField({ name: "mode", values: ["shared", "exclusive"], maxSelect: 1 }))
  app.save(c)
  // The old hooks let a shared request in next to any row that is not "exclusive", and refuse
  // a renew next to an exclusive one: a resource with co-holders goes back to shared, any
  // other to exclusive.
  app.db().newQuery("UPDATE leases SET mode = CASE WHEN (SELECT COUNT(*) FROM leases l WHERE l.resource = leases.resource) > 1 THEN 'shared' ELSE 'exclusive' END").execute()
})
