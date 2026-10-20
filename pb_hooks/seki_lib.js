// Loaded with require() from each route in seki.pb.js. PocketBase runs every
// handler body in its own VM, so functions declared next to routerAdd are not
// visible inside the handler.

// A server started without SEKI_TOKEN refuses everything rather than serving
// leases to anyone. Custom routes are not covered by the collection's API rules.
function authorize(e) {
  const token = $os.getenv("SEKI_TOKEN")
  if (token === "") {
    return { status: 503, body: { ok: false, error: "SEKI_TOKEN is not set on the server" } }
  }
  if (!$security.equal(e.request.header.get("Authorization"), "Bearer " + token)) {
    return { status: 401, body: { ok: false, error: "missing or wrong bearer token" } }
  }
  return null
}

function lease(o) {
  return { resource: o.get("resource"), holder: o.get("holder"), host: o.get("host"), why: o.get("why"), expires_at: o.get("expires_at") }
}

function waiter(o, position) {
  return { resource: o.get("resource"), holder: o.get("holder"), host: o.get("host"), why: o.get("why"), queued_at: o.get("queued_at"), expires_at: o.get("expires_at"), position }
}

const MAX_TTL_SEC = 7 * 24 * 3600
const MAX_QUEUE_TTL_SEC = 3600
const MAX_TEXT = 500

function text(v, required) {
  if (v === undefined || v === null) return !required
  return typeof v === "string" && v.length <= MAX_TEXT && (!required || v !== "")
}

function validAcquire(b) {
  return text(b.resource, true) && text(b.holder, true) && text(b.host, false) && text(b.why, false) &&

    (b.renew === undefined || typeof b.renew === "boolean") &&
    (b.not_after === undefined || Number.isInteger(b.not_after)) &&
    (b.queue_ttl_sec === undefined || (Number.isInteger(b.queue_ttl_sec) && b.queue_ttl_sec >= 1 && b.queue_ttl_sec <= MAX_QUEUE_TTL_SEC)) &&
    Number.isInteger(b.ttl_sec) && b.ttl_sec >= 1 && b.ttl_sec <= MAX_TTL_SEC
}

module.exports = { authorize, lease, waiter, validAcquire }
