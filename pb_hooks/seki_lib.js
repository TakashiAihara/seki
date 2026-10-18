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
  return { resource: o.get("resource"), holder: o.get("holder"), mode: o.get("mode"), host: o.get("host"), why: o.get("why"), expires_at: o.get("expires_at") }
}

const MAX_TTL_SEC = 7 * 24 * 3600

function validAcquire(b) {
  return typeof b.resource === "string" && b.resource !== "" &&
    typeof b.holder === "string" && b.holder !== "" &&
    (b.mode === "shared" || b.mode === "exclusive") &&
    typeof b.ttl_sec === "number" && Number.isFinite(b.ttl_sec) && b.ttl_sec > 0 && b.ttl_sec <= MAX_TTL_SEC
}

module.exports = { authorize, lease, validAcquire }
