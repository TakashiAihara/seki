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
  if (e.request.header.get("Authorization") !== "Bearer " + token) {
    return { status: 401, body: { ok: false, error: "missing or wrong bearer token" } }
  }
  return null
}

function lease(o) {
  return { resource: o.get("resource"), holder: o.get("holder"), mode: o.get("mode"), host: o.get("host"), why: o.get("why"), expires_at: o.get("expires_at") }
}

module.exports = { authorize, lease }
