/// <reference path="../pb_data/types.d.ts" />

// Acquire and renew are the same call: the same holder asking again moves its expiry.
// not_after (Unix ms) is when the client stops waiting for the answer: a request that
// is processed later than that is refused with 408 and creates nothing, so a client
// that gave up never leaves a lease behind it does not know about.
// With renew: true the caller only wants to extend a live lease: if it is gone the
// answer is 410 and nothing is created, so a renew delayed past the lease's expiry
// cannot bring the lease back.
// With queue_ttl_sec a refused caller is put in (or kept in) the resource's FIFO queue
// until then, and the answer says its position; it asks again to stay and to get in.
// The check and the write share one transaction. PocketBase runs transactions on
// a single connection, so two acquires for the same resource cannot interleave.
routerAdd("POST", "/api/seki/acquire", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const b = e.requestInfo().body
  if (!seki.validAcquire(b)) {
    return e.json(400, { ok: false, error: "resource and holder (strings up to 500 chars), mode (shared|exclusive) and ttl_sec (integer, 1 to 604800) are required; host and why are optional strings up to 500 chars; queue_ttl_sec is an optional integer, 1 to 3600" })
  }

  let res
  $app.runInTransaction((tx) => {
    // Taken inside the transaction: waiting for another one must not make an expired lease look live.
    const now = Date.now()
    if (b.not_after !== undefined && now > b.not_after) {
      res = { status: 408, body: { ok: false, server_now: now, error: "the request arrived after its not_after (check clock sync between client and server)" } }
      return
    }
    tx.db().newQuery("DELETE FROM leases WHERE expires_at < {:now}").bind({ now }).execute()
    tx.db().newQuery("DELETE FROM waiters WHERE expires_at < {:now}").bind({ now }).execute()

    const others = tx.findRecordsByFilter("leases", "resource = {:r} && holder != {:h}", "", 0, 0, { r: b.resource, h: b.holder })
    const blocking = others.filter((o) => seki.conflicts(b.mode, o.get("mode")))

    // Expired rows were deleted above, so a row found here is a live lease being renewed.
    const mine = tx.findRecordsByFilter("leases", "resource = {:r} && holder = {:h}", "", 1, 0, { r: b.resource, h: b.holder })
    const renewed = mine.length > 0

    // A holder is ahead of everyone waiting, also when it moves its shared lease to exclusive:
    // the waiters need it to let go anyway, so making it wait for them would leave both waiting.
    // Anyone else comes after the waiters queued before it; a request that does not queue comes
    // after all of them, so it cannot take the resource from under the queue the moment it frees
    // up (it still goes in with shared waiters when it is shared too). A renew (renew: true)
    // never queues: a lapsed one gets 410 below.
    const queue = tx.findRecordsByFilter("waiters", "resource = {:r}", "queued_at,id", 0, 0, { r: b.resource })
    const at = queue.findIndex((w) => w.get("holder") === b.holder)
    const ahead = renewed || b.renew === true ? [] : at < 0 ? queue : queue.slice(0, at)
    const waitingFor = ahead.filter((w) => seki.blockedByWaiter(b.mode, w.get("mode")))

    if (blocking.length > 0 || waitingFor.length > 0) {
      const body = { ok: false, held_by: blocking.map(seki.lease), waiting: ahead.map((w, i) => seki.waiter(w, i + 1)), queued: false }
      if (b.queue_ttl_sec !== undefined && b.renew !== true) {
        const w = at >= 0 ? queue[at] : new Record(tx.findCollectionByNameOrId("waiters"))
        if (at < 0) {
          w.set("resource", b.resource)
          w.set("holder", b.holder)
          // Strictly after the last waiter, so two arriving in the same millisecond keep their order.
          w.set("queued_at", queue.length > 0 ? Math.max(now, queue[queue.length - 1].get("queued_at") + 1) : now)
        }
        w.set("mode", b.mode)
        w.set("host", b.host || "")
        w.set("why", b.why || "")
        w.set("expires_at", now + b.queue_ttl_sec * 1000)
        tx.save(w)
        body.queued = true
        body.position = (at < 0 ? queue.length : at) + 1
      }
      res = { status: 409, body }
      return
    }

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
    // A holder renewing its shared lease while it waits to go exclusive stays in the queue.
    if (at >= 0 && queue[at].get("mode") === b.mode) tx.delete(queue[at])
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

// Leaves the queue without touching a lease the caller may hold (one waiting to move a
// shared lease to exclusive keeps the shared one when it gives up).
routerAdd("POST", "/api/seki/unqueue", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const b = e.requestInfo().body
  if (typeof b.resource !== "string" || typeof b.holder !== "string") {
    return e.json(400, { ok: false, error: "resource and holder (strings) are required" })
  }
  const r = $app.db().newQuery("DELETE FROM waiters WHERE resource = {:r} AND holder = {:h}").bind({ r: b.resource, h: b.holder }).execute()
  return e.json(200, { ok: true, unqueued: r.rowsAffected() })
})

routerAdd("GET", "/api/seki/leases", (e) => {
  const seki = require(`${__hooks}/seki_lib.js`)
  const denied = seki.authorize(e)
  if (denied) return e.json(denied.status, denied.body)

  const now = Date.now()
  const rows = $app.findRecordsByFilter("leases", "expires_at >= {:now}", "resource,holder", 0, 0, { now })
  const queued = $app.findRecordsByFilter("waiters", "expires_at >= {:now}", "resource,queued_at,id", 0, 0, { now })
  let position = 0
  const waiting = queued.map((w, i) => {
    position = i > 0 && queued[i - 1].get("resource") === w.get("resource") ? position + 1 : 1
    return seki.waiter(w, position)
  })
  return e.json(200, { ok: true, leases: rows.map(seki.lease), waiting })
})
