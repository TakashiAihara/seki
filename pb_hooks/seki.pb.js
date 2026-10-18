/// <reference path="../pb_data/types.d.ts" />

// Acquire and renew are the same call: the same holder asking again moves its expiry.
// not_after (Unix ms) is when the client stops waiting for the answer: a request that
// is processed later than that is refused with 408 and creates nothing, so a client
// that gave up never leaves a lease behind it does not know about.
// With renew: true the caller only wants to extend a live lease: if it is gone the
// answer is 410 and nothing is created, so a renew delayed past the lease's expiry
// cannot bring the lease back.
// The check and the write share one transaction. PocketBase runs transactions on
// a single connection, so two acquires for the same resource cannot interleave.
routerAdd("POST", "/api/seki/acquire", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const b = e.requestInfo().body
  if (!seki.validAcquire(b)) {
    return e.json(400, { ok: false, error: "resource and holder (strings up to 500 chars), mode (shared|exclusive) and ttl_sec (integer, 1 to 604800) are required; host and why are optional strings up to 500 chars" })
  }

  let res
  $app.runInTransaction((tx) => {
    // Taken inside the transaction: waiting for another one must not make an expired lease look live.
    const now = Date.now()
    if (b.not_after !== undefined && now > b.not_after) {
      res = { status: 408, body: { ok: false, error: "the request arrived after its not_after" } }
      return
    }
    tx.db().newQuery("DELETE FROM leases WHERE expires_at < {:now}").bind({ now }).execute()

    const others = tx.findRecordsByFilter("leases", "resource = {:r} && holder != {:h}", "", 0, 0, { r: b.resource, h: b.holder })
    const blocking = others.filter((o) => b.mode === "exclusive" || o.get("mode") === "exclusive")
    if (blocking.length > 0) {
      res = { status: 409, body: { ok: false, held_by: blocking.map(seki.lease) } }
      return
    }

    // Expired rows were deleted above, so a row found here is a live lease being renewed.
    const mine = tx.findRecordsByFilter("leases", "resource = {:r} && holder = {:h}", "", 1, 0, { r: b.resource, h: b.holder })
    const renewed = mine.length > 0
    if (b.renew === true && !renewed) {
      res = { status: 410, body: { ok: false, error: "no live lease to renew" } }
      return
    }
    const rec = renewed ? mine[0] : new Record(tx.findCollectionByNameOrId("leases"))
    rec.set("resource", b.resource)
    rec.set("holder", b.holder)
    rec.set("mode", b.mode)
    rec.set("host", b.host || "")
    rec.set("why", b.why || "")
    rec.set("expires_at", now + b.ttl_sec * 1000)
    tx.save(rec)
    res = { status: 200, body: { ok: true, renewed, lease: seki.lease(rec) } }
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
