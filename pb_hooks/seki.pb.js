/// <reference path="../pb_data/types.d.ts" />

// Acquire and renew are the same call: the same holder asking again moves its expiry.
// The check and the write share one transaction. PocketBase runs transactions on
// a single connection, so two acquires for the same resource cannot interleave.
routerAdd("POST", "/api/seki/acquire", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const b = e.requestInfo().body
  if (!seki.validAcquire(b)) {
    return e.json(400, { ok: false, error: "resource and holder (strings), mode (shared|exclusive) and ttl_sec (number, 1 to 604800) are required" })
  }

  const now = Date.now()
  let res
  $app.runInTransaction((tx) => {
    tx.db().newQuery("DELETE FROM leases WHERE expires_at < {:now}").bind({ now }).execute()

    const others = tx.findRecordsByFilter("leases", "resource = {:r} && holder != {:h}", "", 0, 0, { r: b.resource, h: b.holder })
    const blocking = others.filter((o) => b.mode === "exclusive" || o.get("mode") === "exclusive")
    if (blocking.length > 0) {
      res = { status: 409, body: { ok: false, held_by: blocking.map(seki.lease) } }
      return
    }

    const mine = tx.findRecordsByFilter("leases", "resource = {:r} && holder = {:h}", "", 1, 0, { r: b.resource, h: b.holder })
    const rec = mine.length > 0 ? mine[0] : new Record(tx.findCollectionByNameOrId("leases"))
    rec.set("resource", b.resource)
    rec.set("holder", b.holder)
    rec.set("mode", b.mode)
    rec.set("host", b.host || "")
    rec.set("why", b.why || "")
    rec.set("expires_at", now + b.ttl_sec * 1000)
    tx.save(rec)
    res = { status: 200, body: { ok: true, lease: seki.lease(rec) } }
  })
  return e.json(res.status, res.body)
})

routerAdd("POST", "/api/seki/release", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const b = e.requestInfo().body
  if (typeof b.resource !== "string" || typeof b.holder !== "string") {
    return e.json(400, { ok: false, error: "resource and holder (strings) are required" })
  }
  const r = $app.db().newQuery("DELETE FROM leases WHERE resource = {:r} AND holder = {:h}").bind({ r: b.resource, h: b.holder }).execute()
  return e.json(200, { ok: true, released: r.rowsAffected() })
})

routerAdd("GET", "/api/seki/leases", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const rows = $app.findRecordsByFilter("leases", "expires_at >= {:now}", "resource,holder", 0, 0, { now: Date.now() })
  return e.json(200, { ok: true, leases: rows.map(seki.lease) })
})
