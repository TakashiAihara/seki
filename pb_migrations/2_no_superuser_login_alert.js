/// <reference path="../pb_data/types.d.ts" />
// The server has no way to send mail, so the "login from a new location" alert for
// superusers only leaves a sendmail process retrying in the background.
migrate((app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.authAlert.enabled = false
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.authAlert.enabled = true
  app.save(c)
})
