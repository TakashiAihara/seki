/// <reference path="../pb_data/types.d.ts" />
// The server is not set up to send mail, so the "login from a new location" alert for
// superusers can only fail; it also makes every superuser login wait on the attempt.
// deploy/seki.service hides sendmail so that the other mail routes fail at once too.
migrate((app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.authAlert.enabled = false
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.authAlert.enabled = true
  app.save(c)
})
