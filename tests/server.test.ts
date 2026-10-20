import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Server } from "./helpers/server";

let s: Server;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.stop();
});

const post = (path: string, body: unknown, token = s.token) =>
  fetch(`${s.url}/api/seki/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const acquire = (resource: string, holder: string, mode: string, ttl_sec = 60) => post("acquire", { resource, holder, mode, ttl_sec, host: "h", why: `why-${holder}` });
const leases = async () => ((await (await fetch(`${s.url}/api/seki/leases`, { headers: { authorization: `Bearer ${s.token}` } })).json()) as { leases: { resource: string; holder: string; mode: string }[] }).leases;

describe("concurrent acquire", () => {
  test("ten exclusive acquires at once let exactly one through, every round", async () => {
    for (let round = 0; round < 20; round++) {
      const res = `race-x-${round}`;
      const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => acquire(res, `x${i}`, "exclusive").then((r) => r.status)));
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(9);
    }
  });

  test("shared and exclusive racing never end up holding together", async () => {
    for (let round = 0; round < 20; round++) {
      const res = `race-mix-${round}`;
      // Shuffled so neither mode always goes out first.
      const order = Array.from({ length: 5 }, (_, i) => [`shared:s${i}`, `exclusive:x${i}`]).flat().sort(() => Math.random() - 0.5);
      const reqs = order.map((o) => acquire(res, o.split(":")[1]!, o.split(":")[0]!));
      const codes = (await Promise.all(reqs)).map((r) => r.status);
      expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
      const held = (await leases()).filter((l) => l.resource === res);
      expect(held).toHaveLength(codes.filter((c) => c === 200).length);
      const exclusive = held.filter((l) => l.mode === "exclusive");
      expect(held.length).toBeGreaterThan(0);
      if (exclusive.length > 0) expect(held).toHaveLength(1);
    }
  });
});

describe("modes", () => {
  test("several shared holders coexist and block an exclusive one", async () => {
    expect((await acquire("m1", "a", "shared")).status).toBe(200);
    expect((await acquire("m1", "b", "shared")).status).toBe(200);
    const r = await acquire("m1", "c", "exclusive");
    expect(r.status).toBe(409);
    const body = (await r.json()) as { held_by: { holder: string; why: string }[] };
    expect(body.held_by.map((h) => h.holder).sort()).toEqual(["a", "b"]);
    expect(body.held_by.map((h) => h.why).sort()).toEqual(["why-a", "why-b"]);
  });

  test("an exclusive holder blocks a shared one, other resources are independent", async () => {
    expect((await acquire("m2", "a", "exclusive")).status).toBe(200);
    expect((await acquire("m2", "b", "shared")).status).toBe(409);
    expect((await acquire("m2-other", "b", "exclusive")).status).toBe(200);
  });

  test("the same holder asking again renews instead of conflicting with itself", async () => {
    const first = (await (await acquire("m3", "a", "exclusive", 10)).json()) as { renewed: boolean; lease: { expires_at: number } };
    const again = (await (await acquire("m3", "a", "exclusive", 3600)).json()) as { renewed: boolean; lease: { expires_at: number } };
    expect(again.lease.expires_at - first.lease.expires_at).toBeGreaterThan(3000 * 1000);
    expect(first.renewed).toBe(false);
    expect(again.renewed).toBe(true);
  });

  test("a renew for a lease that is gone is refused with 410 and creates nothing", async () => {
    const r = await post("acquire", { resource: "m3c", holder: "a", mode: "exclusive", ttl_sec: 60, renew: true });
    expect(r.status).toBe(410);
    expect((await leases()).some((l) => l.resource === "m3c")).toBe(false);

    await acquire("m3d", "a", "exclusive", 1);
    await Bun.sleep(1500);
    expect((await post("acquire", { resource: "m3d", holder: "a", mode: "exclusive", ttl_sec: 60, renew: true })).status).toBe(410);
    expect((await leases()).some((l) => l.resource === "m3d")).toBe(false);
  });

  test("a request that reaches the server after its not_after is refused with 408 and creates nothing", async () => {
    const late = await post("acquire", { resource: "m6", holder: "a", mode: "exclusive", ttl_sec: 60, not_after: Date.now() - 1 });
    expect(late.status).toBe(408);
    expect(typeof ((await late.json()) as { server_now: unknown }).server_now).toBe("number");
    expect((await leases()).some((l) => l.resource === "m6")).toBe(false);
    const inTime = await post("acquire", { resource: "m6", holder: "a", mode: "exclusive", ttl_sec: 60, not_after: Date.now() + 5000 });
    expect(inTime.status).toBe(200);
  });

  test("a renew of a live lease extends it", async () => {
    await acquire("m3e", "a", "exclusive", 10);
    const r = await post("acquire", { resource: "m3e", holder: "a", mode: "exclusive", ttl_sec: 3600, renew: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { renewed: boolean }).renewed).toBe(true);
  });

  test("asking again after the lease lapsed creates a new one and says so", async () => {
    await acquire("m3b", "a", "exclusive", 1);
    await Bun.sleep(1500);
    const again = (await (await acquire("m3b", "a", "exclusive", 60)).json()) as { renewed: boolean };
    expect(again.renewed).toBe(false);
  });

  test("a ttl of exactly 7 days is accepted", async () => {
    expect((await acquire("m5", "a", "shared", 604800)).status).toBe(200);
  });

  test("release frees the resource and reports what it removed", async () => {
    await acquire("m4", "a", "exclusive");
    const r = (await (await post("release", { resource: "m4", holder: "a" })).json()) as { released: number };
    expect(r.released).toBe(1);
    expect((await acquire("m4", "b", "exclusive")).status).toBe(200);
    const again = (await (await post("release", { resource: "m4", holder: "a" })).json()) as { released: number };
    expect(again.released).toBe(0);
  });
});

describe("queue", () => {
  type Refusal = { held_by: { holder: string }[]; waiting: { holder: string; position: number }[]; queued: boolean; position?: number };
  const wait = (resource: string, holder: string, mode: string, queue_ttl_sec = 60) =>
    post("acquire", { resource, holder, mode, ttl_sec: 60, host: "h", why: `why-${holder}`, queue_ttl_sec });
  const refusal = async (r: Response) => {
    expect(r.status).toBe(409);
    return (await r.json()) as Refusal;
  };
  const waiting = async () =>
    ((await (await fetch(`${s.url}/api/seki/leases`, { headers: { authorization: `Bearer ${s.token}` } })).json()) as { waiting: { resource: string; holder: string; position: number }[] }).waiting;

  test("waiters get the resource in the order they came, and a request that does not queue goes last", async () => {
    await acquire("q1", "a", "exclusive");
    expect(await refusal(await wait("q1", "b", "exclusive"))).toMatchObject({ queued: true, position: 1 });
    expect(await refusal(await wait("q1", "c", "exclusive"))).toMatchObject({ queued: true, position: 2 });
    const d = await refusal(await acquire("q1", "d", "exclusive"));
    expect(d.queued).toBe(false);
    expect(d.waiting.map((w) => [w.holder, w.position])).toEqual([["b", 1], ["c", 2]]);

    await post("release", { resource: "q1", holder: "a" });
    const c = await refusal(await wait("q1", "c", "exclusive"));
    expect(c.held_by).toEqual([]);
    expect(c.position).toBe(2);
    expect((await acquire("q1", "d", "exclusive")).status).toBe(409);
    expect((await wait("q1", "b", "exclusive")).status).toBe(200);
    expect((await waiting()).filter((w) => w.resource === "q1").map((w) => [w.holder, w.position])).toEqual([["c", 1]]);

    await post("release", { resource: "q1", holder: "b" });
    expect((await wait("q1", "c", "exclusive")).status).toBe(200);
  });

  test("a shared request does not pass an exclusive waiter, even while only shared holders hold it", async () => {
    await acquire("q2", "a", "shared");
    await wait("q2", "x", "exclusive");
    const s2 = await refusal(await acquire("q2", "s", "shared"));
    expect(s2.held_by).toEqual([]);
    expect(s2.waiting.map((w) => w.holder)).toEqual(["x"]);
  });

  test("shared waiters do not hold each other up", async () => {
    await acquire("q3", "a", "exclusive");
    await wait("q3", "s1", "shared");
    await wait("q3", "s2", "shared");
    await post("release", { resource: "q3", holder: "a" });
    expect((await wait("q3", "s2", "shared")).status).toBe(200);
    expect((await wait("q3", "s1", "shared")).status).toBe(200);
  });

  test("a holder renewing is not held up by the queue", async () => {
    await acquire("q4", "a", "exclusive");
    await wait("q4", "b", "exclusive");
    expect((await post("acquire", { resource: "q4", holder: "a", mode: "exclusive", ttl_sec: 60, renew: true })).status).toBe(200);
  });

  test("a renew of a lapsed lease is refused with 410 while others wait", async () => {
    await acquire("q8", "a", "exclusive", 1);
    await wait("q8", "c", "exclusive");
    await Bun.sleep(1500);
    expect((await post("acquire", { resource: "q8", holder: "a", mode: "exclusive", ttl_sec: 60, renew: true })).status).toBe(410);
  });

  test("a sole shared holder moves to exclusive ahead of an exclusive waiter, which needs it to let go anyway", async () => {
    await acquire("q9", "a", "shared");
    await wait("q9", "x", "exclusive");
    expect((await wait("q9", "a", "exclusive")).status).toBe(200);
    expect((await waiting()).filter((w) => w.resource === "q9").map((w) => w.holder)).toEqual(["x"]);
  });

  test("renewing a shared lease keeps the holder's pending move to exclusive in the queue", async () => {
    await acquire("q10", "a", "shared");
    await acquire("q10", "b", "shared");
    expect((await refusal(await wait("q10", "a", "exclusive"))).queued).toBe(true);
    expect((await acquire("q10", "a", "shared")).status).toBe(200);
    expect((await waiting()).filter((w) => w.resource === "q10").map((w) => w.holder)).toEqual(["a"]);
  });

  test("a waiter that stops asking falls out of the queue after its queue_ttl_sec", async () => {
    await acquire("q5", "a", "exclusive");
    await wait("q5", "b", "exclusive", 1);
    await post("release", { resource: "q5", holder: "a" });
    expect((await acquire("q5", "c", "exclusive")).status).toBe(409);
    await Bun.sleep(1500);
    expect((await acquire("q5", "c", "exclusive")).status).toBe(200);
  });

  test("unqueue leaves the queue and keeps the caller's lease", async () => {
    await acquire("q6", "a", "shared");
    await acquire("q6", "b", "shared");
    const up = await refusal(await wait("q6", "a", "exclusive"));
    expect(up.queued).toBe(true);
    const r = (await (await post("unqueue", { resource: "q6", holder: "a" })).json()) as { unqueued: number };
    expect(r.unqueued).toBe(1);
    expect((await waiting()).some((w) => w.resource === "q6")).toBe(false);
    expect((await leases()).some((l) => l.resource === "q6" && l.holder === "a")).toBe(true);
  });

  test("ten callers queueing at once get positions 1 to 10", async () => {
    await acquire("q7", "a", "exclusive");
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => wait("q7", `w${i}`, "exclusive").then(refusal)));
    expect(answers.map((a) => a.position).sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Each caller's place as acquire told it matches its place in the list.
    const told = answers.map((a, i): [string, number] => [`w${i}`, a.position!]).sort((x, y) => x[1] - y[1]);
    expect((await waiting()).filter((w) => w.resource === "q7").map((w) => [w.holder, w.position])).toEqual(told);
  });
});

describe("expiry", () => {
  test("a lease stops blocking once its ttl has passed and drops out of the list", async () => {
    await acquire("e1", "a", "exclusive", 1);
    expect((await acquire("e1", "b", "exclusive")).status).toBe(409);
    expect((await leases()).some((l) => l.resource === "e1" && l.holder === "a")).toBe(true);
    await Bun.sleep(1500);
    expect((await leases()).some((l) => l.resource === "e1" && l.holder === "a")).toBe(false);
    expect((await acquire("e1", "b", "exclusive")).status).toBe(200);
  });
});

describe("input", () => {
  test.each([
    [{ holder: "a", mode: "shared", ttl_sec: 60 }],
    [{ resource: "i1", mode: "shared", ttl_sec: 60 }],
    [{ resource: "i1", holder: "a", mode: "both", ttl_sec: 60 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 0 }],
    [{ resource: { x: 1 }, holder: "a", mode: "shared", ttl_sec: 60 }],
    [{ resource: "i1", holder: 7, mode: "shared", ttl_sec: 60 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: "60" }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 1e308 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 604801 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 0.5 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 1.5 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, why: 3 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, host: "h".repeat(501) }],
    [{ resource: "r".repeat(501), holder: "a", mode: "shared", ttl_sec: 60 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, renew: "yes" }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, not_after: "soon" }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, queue_ttl_sec: 0 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, queue_ttl_sec: 3601 }],
    [{ resource: "i1", holder: "a", mode: "shared", ttl_sec: 60, queue_ttl_sec: "30" }],
  ])("acquire rejects %j with 400", async (body) => {
    expect((await post("acquire", body)).status).toBe(400);
  });
});

describe("auth", () => {
  test("a wrong token is refused on every route", async () => {
    expect((await post("acquire", { resource: "a1", holder: "a", mode: "shared", ttl_sec: 60 }, "wrong")).status).toBe(401);
    expect((await post("release", { resource: "a1", holder: "a" }, "wrong")).status).toBe(401);
    expect((await fetch(`${s.url}/api/seki/leases`)).status).toBe(401);
  });

  test("the lease records are not readable through PocketBase's own record API", async () => {
    expect((await fetch(`${s.url}/api/collections/leases/records`)).status).toBe(403);
    const create = await fetch(`${s.url}/api/collections/leases/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource: "z", holder: "z", mode: "exclusive", expires_at: 9e12 }) });
    expect(create.status).toBe(403);
  });

  test("superuser login alerts are off: the server has no way to send mail", async () => {
    const pw = "pw-" + crypto.randomUUID();
    const up = Bun.spawn([s.binary, "superuser", "upsert", "admin@example.test", pw, "--dir", s.dataDir], { stdout: "ignore", stderr: "ignore" });
    expect(await up.exited).toBe(0);
    const auth = await fetch(`${s.url}/api/collections/_superusers/auth-with-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin@example.test", password: pw }) });
    expect(auth.status).toBe(200);
    const token = ((await auth.json()) as { token: string }).token;
    const col = (await (await fetch(`${s.url}/api/collections/_superusers`, { headers: { Authorization: token } })).json()) as { authAlert: { enabled: boolean } };
    expect(col.authAlert.enabled).toBe(false);
  });

  test("a server started without SEKI_TOKEN refuses everything", async () => {
    const bare = await startServer({ token: null });
    try {
      const r = await fetch(`${bare.url}/api/seki/leases`, { headers: { authorization: "Bearer " } });
      expect(r.status).toBe(503);
      const a = await fetch(`${bare.url}/api/seki/acquire`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " }, body: JSON.stringify({ resource: "a2", holder: "a", mode: "shared", ttl_sec: 60 }) });
      expect(a.status).toBe(503);
    } finally {
      await bare.stop();
    }
  });
});
