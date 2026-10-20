import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type Server } from "./helpers/server";

const entry = join(import.meta.dir, "..", "src", "index.ts");

// run tests wait out real ttls (3 s and up); the 5 s default cuts them off
setDefaultTimeout(20_000);

let s: Server;
beforeAll(async () => {
  s = await startServer();
});
const scratch: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterAll(async () => {
  await s.stop();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

type Run = { code: number; out: string; err: string };

// HOME points at an empty dir so a real ~/.config/seki on the test machine is never read.
async function seki(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const home = tempDir("seki-home-");
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, SEKI_URL: s.url, SEKI_TOKEN: s.token, SEKI_HOLDER: "tester" };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  const p = Bun.spawn(["bun", entry, ...args], { env: base, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

// The same environment as seki(), but the process is handed back so a test can signal it.
function sekiProc(args: string[]) {
  const env = { PATH: process.env.PATH ?? "", HOME: tempDir("seki-home-"), SEKI_URL: s.url, SEKI_TOKEN: s.token, SEKI_HOLDER: "tester" };
  return Bun.spawn(["bun", entry, ...args], { env, stdout: "ignore", stderr: "ignore" });
}

// A proxy to the test server whose renews (every acquire after the first) fail with 502.
function failingRenews() {
  let acquires = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : undefined;
      if (u.pathname === "/api/seki/acquire" && ++acquires > 1) return new Response("down", { status: 502 });
      return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
    },
  });
  return { url: `http://127.0.0.1:${proxy.port}`, stop: () => proxy.stop(true) };
}

type Lease = { resource: string; holder: string; mode: string; host: string; why: string; expires_at: number };
async function ls(): Promise<Lease[]> {
  const r = await seki(["ls", "--json"]);
  expect(r.code).toBe(0);
  return (JSON.parse(r.out) as { leases: Lease[] }).leases;
}

describe("acquire", () => {
  test("exclusive is taken once; a second holder gets exit 1 with who holds it and why", async () => {
    const a = await seki(["acquire", "c1", "--exclusive", "--why", "tagger batch"], { SEKI_HOLDER: "alice" });
    expect(a.code).toBe(0);
    expect(a.out).toContain("acquired c1 exclusive");

    const b = await seki(["acquire", "c1", "--exclusive"], { SEKI_HOLDER: "bob" });
    expect(b.code).toBe(1);
    expect(b.err).toContain("alice");
    expect(b.err).toContain("tagger batch");
  });

  test("shared holders coexist and keep an exclusive one out", async () => {
    expect((await seki(["acquire", "c2", "--shared"], { SEKI_HOLDER: "a" })).code).toBe(0);
    expect((await seki(["acquire", "c2", "--shared"], { SEKI_HOLDER: "b" })).code).toBe(0);
    expect((await seki(["acquire", "c2", "--exclusive"], { SEKI_HOLDER: "c" })).code).toBe(1);
  });

  test("records the holder, the host and the reason", async () => {
    await seki(["acquire", "c3", "--shared", "--why", "llama-server on 6006"], { SEKI_HOLDER: "carol" });
    const l = (await ls()).find((x) => x.resource === "c3");
    expect(l?.holder).toBe("carol");
    expect(l?.mode).toBe("shared");
    expect(l?.why).toBe("llama-server on 6006");
    expect(l?.host).toBe(hostname());
  });

  test("--holder beats SEKI_HOLDER", async () => {
    await seki(["acquire", "c4", "--shared", "--holder", "dave"], { SEKI_HOLDER: "erin" });
    expect((await ls()).find((x) => x.resource === "c4")?.holder).toBe("dave");
  });

  test("acquire without --holder or SEKI_HOLDER is refused: two callers would share one lease", async () => {
    const r = await seki(["acquire", "c5", "--shared"], { SEKI_HOLDER: undefined, USER: "frank" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("set --holder or SEKI_HOLDER");
    expect((await ls()).some((x) => x.resource === "c5")).toBe(false);
  });

  test("release without --holder or SEKI_HOLDER is refused", async () => {
    const r = await seki(["release", "c5"], { SEKI_HOLDER: undefined, USER: "frank" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("set --holder or SEKI_HOLDER");
  });

  test("a holder in the config file is not used", async () => {
    const home = tempDir("seki-cfg-");
    mkdirSync(join(home, ".config", "seki"), { recursive: true });
    writeFileSync(join(home, ".config", "seki", "config.json"), JSON.stringify({ url: s.url, token: s.token, holder: "from-file" }));
    const p = Bun.spawn(["bun", entry, "acquire", "c5b", "--shared"], { env: { PATH: process.env.PATH ?? "", HOME: home, USER: "frank" }, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
    expect(await new Response(p.stderr).text()).toContain("SEKI_HOLDER");
  });

  test("--ttl above 7 days is a usage error", async () => {
    const over = await seki(["acquire", "c5c", "--shared", "--ttl", "169h"]);
    expect(over.code).toBe(2);
    expect(over.err).toContain("7 days");
    expect((await seki(["acquire", "c5c", "--shared", "--ttl", "168h"])).code).toBe(0);
  });

  test.each([
    ["90s", 90],
    ["30m", 1800],
    ["6h", 21600],
    ["45", 45],
  ])("--ttl %s sets the expiry %i seconds ahead", async (ttl, sec) => {
    const res = `ttl-${ttl}`;
    const before = Date.now();
    expect((await seki(["acquire", res, "--shared", "--ttl", ttl])).code).toBe(0);
    const l = (await ls()).find((x) => x.resource === res)!;
    expect(l.expires_at - before).toBeGreaterThanOrEqual(sec * 1000 - 2000);
    expect(l.expires_at - before).toBeLessThanOrEqual(sec * 1000 + 5000);
  });

  test("the default ttl is ten minutes", async () => {
    const before = Date.now();
    await seki(["acquire", "c6", "--shared"]);
    const l = (await ls()).find((x) => x.resource === "c6")!;
    expect(l.expires_at - before).toBeGreaterThanOrEqual(600_000 - 2000);
    expect(l.expires_at - before).toBeLessThanOrEqual(600_000 + 5000);
  });

  test("acquiring again by the same holder moves the expiry of its own lease", async () => {
    await seki(["acquire", "c7", "--exclusive", "--ttl", "60"]);
    expect((await seki(["acquire", "c7", "--exclusive", "--ttl", "2h"])).code).toBe(0);
    const l = (await ls()).find((x) => x.resource === "c7")!;
    expect(l.expires_at - Date.now()).toBeGreaterThan(3600 * 1000);
  });

  test("there is no renew command", async () => {
    expect((await seki(["renew", "c7", "--exclusive"])).code).toBe(2);
  });

  test("a ttl under 3 seconds is a usage error", async () => {
    const r = await seki(["acquire", "c8", "--shared", "--ttl", "2s"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("at least 3s");
  });
});

describe("usage errors exit 2", () => {
  test.each([
    [["acquire", "u1"]],
    [["acquire", "u1", "--shared", "--exclusive"]],
    [["acquire", "--shared"]],
    [["acquire", "u1", "--shared", "--ttl", "soon"]],
    [["acquire", "u1", "--shared", "--ttl", "0"]],
    [["frobnicate"]],
  ])("%j", async (args) => {
    expect((await seki(args)).code).toBe(2);
  });

  test.each([
    [["run", "u1", "--shared"]],
    [["run", "u1", "--", "true"]],
    [["run", "u1", "--shared", "--ttl", "soon", "--", "true"]],
  ])("run usage error %j exits 125, not a code the command could have returned", async (args) => {
    expect((await seki(args)).code).toBe(125);
  });

  test("run with the command but no -- before it is refused and runs nothing", async () => {
    const marker = join(tempDir("seki-run-"), "ran");
    const r = await seki(["run", "u2", "--shared", "touch", marker]);
    expect(r.code).toBe(125);
    expect(r.err).toContain("--");
    expect(existsSync(marker)).toBe(false);
  });

  test("run with -- only inside an option value is refused", async () => {
    const marker = join(tempDir("seki-run-"), "ran");
    const r = await seki(["run", "u3", "--shared", "--why", "--", "touch", marker]);
    expect(r.code).toBe(125);
    expect(existsSync(marker)).toBe(false);
  });

  test("options after -- belong to the command, not to seki", async () => {
    const r = await seki(["run", "u4", "--shared", "--", "sh", "-c", "echo $0 $1", "--exclusive", "--ttl"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--exclusive --ttl");
  });
});

describe("release and ls", () => {
  test("release frees the resource; releasing again still exits 0", async () => {
    await seki(["acquire", "r1", "--exclusive"], { SEKI_HOLDER: "a" });
    const r = await seki(["release", "r1"], { SEKI_HOLDER: "a" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("released r1");
    expect((await seki(["acquire", "r1", "--exclusive"], { SEKI_HOLDER: "b" })).code).toBe(0);
    const again = await seki(["release", "r1"], { SEKI_HOLDER: "a" });
    expect(again.code).toBe(0);
    expect(again.out).toContain("not held r1");
  });

  test("release only drops the caller's own lease", async () => {
    await seki(["acquire", "r2", "--shared"], { SEKI_HOLDER: "a" });
    await seki(["acquire", "r2", "--shared"], { SEKI_HOLDER: "b" });
    const r = await seki(["release", "r2"], { SEKI_HOLDER: "b" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("released r2");
    const held = (await ls()).filter((x) => x.resource === "r2").map((x) => x.holder);
    expect(held).toEqual(["a"]);
  });

  test("ls prints a table with a header and one row per lease", async () => {
    await seki(["acquire", "r3", "--exclusive", "--why", "restart notebook"], { SEKI_HOLDER: "gina" });
    const r = await seki(["ls"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(/^RESOURCE\s+MODE\s+HOLDER\s+HOST\s+EXPIRES\s+WHY$/);
    const row = lines.find((l) => l.startsWith("r3 "));
    expect(row).toMatch(/^r3\s+exclusive\s+gina\s+\S+\s+in \d+m\s+restart notebook$/);
  });
});

describe("run", () => {
  test("runs the command while holding the lease, passes its exit code through and releases", async () => {
    const r = await seki(["run", "x1", "--exclusive", "--", "sh", "-c", "echo inside; exit 7"]);
    expect(r.code).toBe(7);
    expect(r.out).toContain("inside");
    expect((await ls()).some((x) => x.resource === "x1")).toBe(false);
  });

  test("the lease is held while the command runs", async () => {
    const dir = tempDir("seki-run-");
    const marker = join(dir, "started");
    const running = seki(["run", "x2", "--exclusive", "--why", "batch", "--", "sh", "-c", `touch ${marker}; sleep 2`], { SEKI_HOLDER: "runner" });
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    const other = await seki(["acquire", "x2", "--shared"], { SEKI_HOLDER: "other" });
    expect(other.code).toBe(1);
    expect(other.err).toContain("runner");
    expect((await running).code).toBe(0);
  });

  test("renews in the background so a command outlives the ttl", async () => {
    const dir = tempDir("seki-run-");
    const marker = join(dir, "late");
    const running = seki(["run", "x3", "--exclusive", "--ttl", "3s", "--", "sh", "-c", `sleep 4.5; touch ${marker}; sleep 1`], { SEKI_HOLDER: "long" });
    for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    expect((await seki(["acquire", "x3", "--exclusive"], { SEKI_HOLDER: "other" })).code).toBe(1);
    expect((await running).code).toBe(0);
  });

  test("run takes the lease with the given --ttl", async () => {
    const marker = join(tempDir("seki-run-"), "started");
    const running = seki(["run", "x7", "--shared", "--ttl", "90s", "--", "sh", "-c", `touch ${marker}; sleep 1`]);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    const l = (await ls()).find((x) => x.resource === "x7")!;
    expect(l.expires_at - Date.now()).toBeLessThanOrEqual(91_000);
    expect(l.expires_at - Date.now()).toBeGreaterThan(80_000);
    expect((await running).code).toBe(0);
  });

  test.each([
    ["without SEKI_HOLDER", { SEKI_HOLDER: undefined, USER: "same" }],
    ["with the same SEKI_HOLDER", { SEKI_HOLDER: "one-session" }],
    ["with the same --holder", { SEKI_HOLDER: undefined, extra: ["--holder", "same-name"] }],
  ] as const)("two runs %s do not share an exclusive lease", async (_, env) => {
    const marker = join(tempDir("seki-run-"), "started");
    const extra = "extra" in env ? [...env.extra] : [];
    const e = { SEKI_HOLDER: env.SEKI_HOLDER, USER: "USER" in env ? env.USER : "u" };
    const first = seki(["run", "x8", "--exclusive", ...extra, "--", "sh", "-c", `touch ${marker}; sleep 2`], e);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    const second = await seki(["run", "x8", "--exclusive", ...extra, "--", "true"], e);
    expect(second.code).toBe(124);
    expect((await first).code).toBe(0);
  });

  test("does not run the command when the resource is held, and exits 124", async () => {
    await seki(["acquire", "x4", "--exclusive"], { SEKI_HOLDER: "owner" });
    const marker = join(tempDir("seki-run-"), "ran");
    const r = await seki(["run", "x4", "--exclusive", "--", "touch", marker], { SEKI_HOLDER: "intruder" });
    expect(r.code).toBe(124);
    expect(r.err).toContain("owner");
    expect(existsSync(marker)).toBe(false);
  });

  test("a command exiting with any of seki's own codes on its own is passed through as is", async () => {
    for (const c of [1, 2, 123, 124, 125, 126, 127]) expect((await seki(["run", `x9-${c}`, "--shared", "--", "sh", "-c", `exit ${c}`])).code).toBe(c);
  });

  test.each([
    ["missing", 127],
    ["not executable", 126],
  ])("a command that is %s exits %i and releases the lease", async (kind, code) => {
    const dir = tempDir("seki-run-");
    const cmd = join(dir, "cmd");
    if (kind === "not executable") writeFileSync(cmd, "#!/bin/sh\n", { mode: 0o644 });
    const r = await seki(["run", `x14-${code}`, "--exclusive", "--", cmd]);
    expect(r.code).toBe(code);
    expect((await ls()).some((x) => x.resource === `x14-${code}`)).toBe(false);
  });

  test("when another holder takes the lease over, the command is stopped and run exits 123", async () => {
    const marker = join(tempDir("seki-run-"), "started");
    const running = seki(["run", "x10", "--exclusive", "--ttl", "3s", "--", "sh", "-c", `touch ${marker}; sleep 20`]);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    const victim = (await ls()).find((x) => x.resource === "x10")!.holder;
    await seki(["release", "x10"], { SEKI_HOLDER: victim });
    expect((await seki(["acquire", "x10", "--exclusive"], { SEKI_HOLDER: "thief" })).code).toBe(0);
    const started = Date.now();
    const r = await running;
    expect(r.code).toBe(123);
    expect(r.err).toContain("thief");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("a server that does not say whether it renewed is refused before the command starts", async () => {
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        const res = await fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
        if (u.pathname !== "/api/seki/acquire" || res.status !== 200) return res;
        const data = (await res.json()) as Record<string, unknown>;
        delete data.renewed;
        return Response.json(data);
      },
    });
    try {
      const marker = join(tempDir("seki-run-"), "ran");
      const r = await seki(["run", "x17", "--exclusive", "--", "touch", marker], { SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      expect(r.code).toBe(125);
      expect(r.err).toContain("renewed");
      expect(existsSync(marker)).toBe(false);
      expect((await ls()).some((x) => x.resource === "x17")).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test("a renew that the server answers by creating a new lease counts as lost", async () => {
    // The proxy drops the lease just before forwarding each renew, so the server
    // has nothing to renew and creates a fresh lease instead.
    let acquires = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire" && ++acquires > 1) {
          const b = JSON.parse(body!) as { resource: string; holder: string };
          await fetch(`${s.url}/api/seki/release`, { method: "POST", headers: req.headers, body: JSON.stringify({ resource: b.resource, holder: b.holder }) });
        }
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const r = await seki(["run", "x15", "--exclusive", "--ttl", "3s", "--", "sleep", "20"], { SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      expect(r.code).toBe(123);
      expect((await ls()).some((x) => x.resource === "x15")).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test("losing the lease stops the whole command, background children and a SIGTERM-ignoring child included", async () => {
    const proxy = failingRenews();
    try {
      const started = Date.now();
      const r = await seki(["run", "x16", "--exclusive", "--ttl", "3s", "--", "sh", "-c", "sleep 22.3 & trap '' TERM; sleep 21.7"], { SEKI_URL: proxy.url, SEKI_KILL_AFTER_MS: "1000" });
      expect(r.code).toBe(123);
      expect(Date.now() - started).toBeLessThan(7000);
      await Bun.sleep(300);
      expect((await Bun.$`pgrep -f "sleep 2[12][.][37]"`.nothrow().quiet()).exitCode).toBe(1);
    } finally {
      proxy.stop();
    }
  });

  test("a process in the command's group that ignores SIGTERM does not outlive a lost lease", async () => {
    const proxy = failingRenews();
    try {
      const r = await seki(["run", "x18", "--exclusive", "--ttl", "3s", "--", "sh", "-c", "(trap '' TERM; exec sleep 51.11) & sleep 51.12"], { SEKI_URL: proxy.url, SEKI_KILL_AFTER_MS: "1000" });
      expect(r.code).toBe(123);
      await Bun.sleep(300);
      expect((await Bun.$`pgrep -f "sleep 51[.]1[12]"`.nothrow().quiet()).exitCode).toBe(1);
    } finally {
      proxy.stop();
    }
  });

  test("a background process that ignores SIGTERM after a normal exit gets SIGKILL after the grace period", async () => {
    const started = Date.now();
    const r = await seki(["run", "x19b", "--exclusive", "--", "sh", "-c", "(trap '' TERM; exec sleep 51.14) & exit 0"], { SEKI_KILL_AFTER_MS: "1000" });
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect((await Bun.$`pgrep -f "sleep 51[.]14"`.nothrow().quiet()).exitCode).toBe(1);
  });

  test("background processes of a command that exits normally are stopped before the release", async () => {
    const r = await seki(["run", "x19", "--exclusive", "--", "sh", "-c", "sleep 51.13 & exit 0"], { SEKI_KILL_AFTER_MS: "1000" });
    expect(r.code).toBe(0);
    expect((await Bun.$`pgrep -f "sleep 51[.]13"`.nothrow().quiet()).exitCode).toBe(1);
  });

  test("a renew cut off by the deadline but processed by the server later does not bring the lease back", async () => {
    let acquires = 0;
    let forwarded!: () => void;
    const lateRenewDone = new Promise<void>((resolve) => (forwarded = resolve));
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname !== "/api/seki/acquire" || ++acquires === 1) {
          return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
        }
        // The first renew still reaches the server, 3.5 s late, after run has given up on it.
        if (acquires === 2) {
          await Bun.sleep(3500);
          const res = await fetch(s.url + u.pathname, { method: "POST", headers: req.headers, body });
          forwarded();
          return res;
        }
        return new Response("down", { status: 502 });
      },
    });
    try {
      const r = await seki(["run", "x20", "--exclusive", "--ttl", "3s", "--", "sleep", "20"], { SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      expect(r.code).toBe(123);
      await lateRenewDone;
      expect((await ls()).some((x) => x.resource === "x20")).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test("a first acquire that reaches the server only after run gave up on it creates nothing", async () => {
    let forwarded!: () => void;
    const late = new Promise<void>((resolve) => (forwarded = resolve));
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire") {
          await Bun.sleep(1500);
          const res = await fetch(s.url + u.pathname, { method: "POST", headers: req.headers, body });
          forwarded();
          return res;
        }
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const marker = join(tempDir("seki-run-"), "ran");
      const r = await seki(["run", "x23", "--exclusive", "--", "touch", marker], { SEKI_URL: `http://127.0.0.1:${proxy.port}`, SEKI_TIMEOUT_MS: "1000" });
      expect(r.code).toBe(125);
      expect(existsSync(marker)).toBe(false);
      await late;
      expect((await ls()).some((x) => x.resource === "x23")).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test("a lost lease still gives the rest of the group the grace period to clean up", async () => {
    const dir = tempDir("seki-run-");
    const cleaned = join(dir, "cleaned");
    const proxy = failingRenews();
    try {
      const r = await seki(["run", "x24", "--exclusive", "--ttl", "3s", "--", "sh", "-c", `(trap 'sleep 0.3; touch ${cleaned}; exit 0' TERM; sleep 61.71 & wait) & exec sleep 61.72`], { SEKI_URL: proxy.url, SEKI_KILL_AFTER_MS: "3000" });
      expect(r.code).toBe(123);
      expect(existsSync(cleaned)).toBe(true);
      expect((await Bun.$`pgrep -f "sleep 61[.]7[12]"`.nothrow().quiet()).exitCode).toBe(1);
    } finally {
      proxy.stop();
    }
  });

  test("a usable SEKI_TIMEOUT_MS is not needed for --version", async () => {
    const r = await seki(["--version"], { SEKI_TIMEOUT_MS: "0" });
    expect(r.code).toBe(0);
  });

  test("SIGQUIT sent to seki reaches the command too", async () => {
    const marker = join(tempDir("seki-run-"), "started");
    const p = sekiProc(["run", "x21", "--exclusive", "--", "sh", "-c", `touch ${marker}; exec sleep 20`]);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    p.kill("SIGQUIT");
    expect(await p.exited).toBe(131);
    expect((await ls()).some((x) => x.resource === "x21")).toBe(false);
  });

  test.each([["SEKI_KILL_AFTER_MS", "-1"], ["SEKI_KILL_AFTER_MS", "soon"], ["SEKI_KILL_AFTER_MS", "1e3"], ["SEKI_TIMEOUT_MS", "0"], ["SEKI_TIMEOUT_MS", "-5"], ["SEKI_TIMEOUT_MS", "0x10"]])(
    "%s=%s is refused before the command starts",
    async (k, v) => {
      const marker = join(tempDir("seki-run-"), "ran");
      const r = await seki(["run", "x22", "--shared", "--", "touch", marker], { [k]: v });
      expect(r.code).toBe(125);
      expect(r.err).toContain(k);
      expect(existsSync(marker)).toBe(false);
    },
  );

  test("when renews keep failing until the lease has lapsed, the command is stopped and run exits 123", async () => {
    const proxy = failingRenews();
    try {
      const started = Date.now();
      const r = await seki(["run", "x11", "--exclusive", "--ttl", "3s", "--", "sleep", "20"], { SEKI_URL: proxy.url });
      expect(r.code).toBe(123);
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      proxy.stop();
    }
  });

  test("a renew that hangs does not keep the command running past the lease's expiry", async () => {
    let acquires = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire" && ++acquires > 1) await Bun.sleep(60_000);
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const started = Date.now();
      const r = await seki(["run", "x13", "--exclusive", "--ttl", "3s", "--", "sleep", "20"], { SEKI_URL: `http://127.0.0.1:${proxy.port}`, SEKI_TIMEOUT_MS: "15000" });
      expect(r.code).toBe(123);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      proxy.stop(true);
    }
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("%s sent to seki reaches the command, and the lease is released", async (sig, code) => {
    const marker = join(tempDir("seki-run-"), "started");
    const p = sekiProc(["run", `x12-${sig}`, "--exclusive", "--", "sh", "-c", `touch ${marker}; exec sleep 20`]);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    p.kill(sig);
    expect(await p.exited).toBe(code);
    expect((await ls()).some((x) => x.resource === `x12-${sig}`)).toBe(false);
  });

  test("a renew still in flight when the command ends does not bring the lease back after release", async () => {
    // A proxy in front of the server holds every renew (the second and later acquire) for 1.5 s,
    // so the renew sent at ~1 s is still on the wire when the 1.2 s command exits.
    let acquires = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire" && ++acquires > 1) await Bun.sleep(1500);
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const r = await seki(["run", "x6", "--exclusive", "--ttl", "3s", "--", "sleep", "1.2"], { SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      expect(r.code).toBe(0);
      expect(acquires).toBeGreaterThan(1);
      await Bun.sleep(2000);
      expect((await ls()).some((x) => x.resource === "x6")).toBe(false);
    } finally {
      proxy.stop(true);
    }
  });

  test("releases when the command is killed by a signal and exits 128 + signal", async () => {
    const r = await seki(["run", "x5", "--shared", "--", "sh", "-c", "kill -TERM $$"]);
    expect(r.code).toBe(143);
    expect((await ls()).some((x) => x.resource === "x5")).toBe(false);
  });
});

describe("--wait", () => {
  type Waiter = { resource: string; holder: string; position: number };
  async function waitingFor(resource: string): Promise<Waiter[]> {
    const r = await seki(["ls", "--json"]);
    return (JSON.parse(r.out) as { waiting: Waiter[] }).waiting.filter((w) => w.resource === resource);
  }
  async function untilQueued(resource: string, n: number) {
    for (let i = 0; i < 100 && (await waitingFor(resource)).length < n; i++) await Bun.sleep(100);
    expect(await waitingFor(resource)).toHaveLength(n);
  }

  test("acquire --wait queues, says its place, and takes the lease once it is released", async () => {
    await seki(["acquire", "w1", "--exclusive"], { SEKI_HOLDER: "owner" });
    const waiting = seki(["acquire", "w1", "--exclusive", "--wait", "30s"], { SEKI_HOLDER: "next" });
    await untilQueued("w1", 1);
    expect((await waitingFor("w1"))[0]).toMatchObject({ holder: "next", position: 1 });
    await seki(["release", "w1"], { SEKI_HOLDER: "owner" });
    const r = await waiting;
    expect(r.code).toBe(0);
    expect(r.err).toContain("number 1 in the queue");
    expect((await ls()).find((x) => x.resource === "w1")?.holder).toBe("next");
    expect(await waitingFor("w1")).toEqual([]);
  });

  test("acquire --wait gives up after the duration with exit 1 and leaves the queue", async () => {
    await seki(["acquire", "w2", "--exclusive"], { SEKI_HOLDER: "owner" });
    const started = performance.now();
    const r = await seki(["acquire", "w2", "--exclusive", "--wait", "3s"], { SEKI_HOLDER: "next" });
    expect(r.code).toBe(1);
    expect(performance.now() - started).toBeGreaterThan(2900);
    expect(performance.now() - started).toBeLessThan(8000);
    expect(r.err).toContain("owner");
    expect(await waitingFor("w2")).toEqual([]);
  });

  test("giving up on moving a shared lease to exclusive keeps the shared lease", async () => {
    await seki(["acquire", "w3", "--shared"], { SEKI_HOLDER: "a" });
    await seki(["acquire", "w3", "--shared"], { SEKI_HOLDER: "b" });
    expect((await seki(["acquire", "w3", "--exclusive", "--wait", "2s"], { SEKI_HOLDER: "a" })).code).toBe(1);
    expect((await ls()).find((x) => x.resource === "w3" && x.holder === "a")?.mode).toBe("shared");
    expect(await waitingFor("w3")).toEqual([]);
  });

  test("a request without --wait does not jump the queue", async () => {
    await seki(["acquire", "w4", "--exclusive"], { SEKI_HOLDER: "owner" });
    const waiting = seki(["acquire", "w4", "--exclusive", "--wait", "30s"], { SEKI_HOLDER: "next" });
    await untilQueued("w4", 1);
    await seki(["release", "w4"], { SEKI_HOLDER: "owner" });
    // The waiter may already hold it by now, or still be waiting ahead: either way the cutter is
    // refused because of it. The server test pins the case where the cutter comes first.
    const cut = await seki(["acquire", "w4", "--exclusive"], { SEKI_HOLDER: "cutter" });
    expect(cut.code).toBe(1);
    expect(cut.err).toContain("exclusive by next");
    expect((await waiting).code).toBe(0);
    expect((await ls()).find((x) => x.resource === "w4")?.holder).toBe("next");
  });

  test("runs waiting for one resource start in the order they queued", async () => {
    await seki(["acquire", "w5", "--exclusive"], { SEKI_HOLDER: "owner" });
    const log = join(tempDir("seki-wait-"), "order");
    const first = seki(["run", "w5", "--exclusive", "--wait", "30s", "--", "sh", "-c", `echo first >> ${log}; sleep 1`], { SEKI_HOLDER: "one" });
    await untilQueued("w5", 1);
    const second = seki(["run", "w5", "--exclusive", "--wait", "30s", "--", "sh", "-c", `echo second >> ${log}`], { SEKI_HOLDER: "two" });
    await untilQueued("w5", 2);
    expect((await waitingFor("w5")).map((w) => [w.holder.split("#")[0], w.position])).toEqual([["one", 1], ["two", 2]]);
    await seki(["release", "w5"], { SEKI_HOLDER: "owner" });
    expect((await first).code).toBe(0);
    expect((await second).code).toBe(0);
    expect(await Bun.file(log).text()).toBe("first\nsecond\n");
  });

  test("run --wait that runs out exits 124 without starting the command", async () => {
    await seki(["acquire", "w6", "--exclusive"], { SEKI_HOLDER: "owner" });
    const marker = join(tempDir("seki-wait-"), "ran");
    const r = await seki(["run", "w6", "--exclusive", "--wait", "2s", "--", "touch", marker], { SEKI_HOLDER: "next" });
    expect(r.code).toBe(124);
    expect(existsSync(marker)).toBe(false);
    expect(await waitingFor("w6")).toEqual([]);
  });

  test("ls shows who waits for what, in which place", async () => {
    await seki(["acquire", "w7", "--exclusive"], { SEKI_HOLDER: "owner" });
    const waiting = seki(["acquire", "w7", "--shared", "--wait", "30s", "--why", "eval run"], { SEKI_HOLDER: "hana" });
    await untilQueued("w7", 1);
    const lines = (await seki(["ls"])).out.trim().split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^RESOURCE\s+POS\s+MODE\s+HOLDER\s+HOST\s+WAITING\s+WHY$/));
    expect(lines).toContainEqual(expect.stringMatching(/^w7\s+1\s+shared\s+hana\s+\S+\s+for \d+m\s+eval run$/));
    await seki(["release", "w7"], { SEKI_HOLDER: "owner" });
    expect((await waiting).code).toBe(0);
  });

  test("a poll that cannot reach the server is retried; the wait goes on", async () => {
    await seki(["acquire", "w9", "--exclusive"], { SEKI_HOLDER: "owner" });
    let acquires = 0;
    // The second acquire hangs past SEKI_TIMEOUT_MS, so the client sees it as unreachable.
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire" && ++acquires === 2) await Bun.sleep(1500);
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const waiting = seki(["acquire", "w9", "--exclusive", "--wait", "30s"], { SEKI_HOLDER: "next", SEKI_URL: `http://127.0.0.1:${proxy.port}`, SEKI_TIMEOUT_MS: "500" });
      for (let i = 0; i < 100 && acquires < 3; i++) await Bun.sleep(100);
      await seki(["release", "w9"], { SEKI_HOLDER: "owner" });
      const r = await waiting;
      expect(r.code).toBe(0);
      expect(r.err).toContain("asking again");
    } finally {
      proxy.stop(true);
    }
  });

  test.each([502, 504])("a gateway error (%d) while waiting is retried too", async (status) => {
    const res = `w10-${status}`;
    await seki(["acquire", res, "--exclusive"], { SEKI_HOLDER: "owner" });
    let acquires = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (u.pathname === "/api/seki/acquire" && ++acquires === 2) return new Response("gateway", { status });
        return fetch(s.url + u.pathname + u.search, { method: req.method, headers: req.headers, body });
      },
    });
    try {
      const waiting = seki(["acquire", res, "--exclusive", "--wait", "30s"], { SEKI_HOLDER: "next", SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      for (let i = 0; i < 100 && acquires < 3; i++) await Bun.sleep(100);
      await seki(["release", res], { SEKI_HOLDER: "owner" });
      const r = await waiting;
      expect(r.code).toBe(0);
      expect(r.err).toContain(`server returned ${status}`);
    } finally {
      proxy.stop(true);
    }
  });

  test.each([
    ["a wrong token", { SEKI_TOKEN: "wrong" }],
    ["an address nothing listens on", { SEKI_URL: "http://127.0.0.1:1" }],
  ])("--wait with %s ends at once with exit 2", async (_, env) => {
    await seki(["acquire", "w11", "--exclusive"], { SEKI_HOLDER: "owner" });
    const started = performance.now();
    const r = await seki(["acquire", "w11", "--exclusive", "--wait", "30s"], { SEKI_HOLDER: "next", ...env });
    expect(r.code).toBe(2);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test.each(["0", "0s", "169h", "soon"])("--wait %s is a usage error", async (v) => {
    expect((await seki(["acquire", "w8", "--shared", "--wait", v])).code).toBe(2);
  });
});

describe("config and failures exit 2", () => {
  test("no url configured", async () => {
    const r = await seki(["ls"], { SEKI_URL: undefined });
    expect(r.code).toBe(2);
    expect(r.err).toContain("SEKI_URL");
  });

  test("no token configured", async () => {
    const r = await seki(["ls"], { SEKI_TOKEN: undefined });
    expect(r.code).toBe(2);
    expect(r.err).toContain("SEKI_TOKEN");
  });

  test("wrong token", async () => {
    expect((await seki(["acquire", "f1", "--shared"], { SEKI_TOKEN: "wrong" })).code).toBe(2);
  });

  test("a server that accepts the connection but never answers is exit 2, not a hang", async () => {
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const started = Date.now();
      const r = await seki(["ls"], { SEKI_URL: `http://127.0.0.1:${silent.port}`, SEKI_TIMEOUT_MS: "1000" });
      expect(r.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      silent.stop(true);
    }
  });

  test("server unreachable", async () => {
    expect((await seki(["acquire", "f2", "--shared"], { SEKI_URL: "http://127.0.0.1:9" })).code).toBe(2);
  });

  test("run does not start the command when the server is unreachable", async () => {
    const dir = tempDir("seki-run-");
    const marker = join(dir, "ran");
    const r = await seki(["run", "f3", "--shared", "--", "touch", marker], { SEKI_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(125);
    expect(existsSync(marker)).toBe(false);
  });

  test("the config file supplies url and a token_command; env wins over the file", async () => {
    const home = tempDir("seki-cfg-");
    mkdirSync(join(home, ".config", "seki"), { recursive: true });
    writeFileSync(join(home, ".config", "seki", "config.json"), JSON.stringify({ url: s.url, token_command: `printf %s ${s.token}` }));
    const p = Bun.spawn(["bun", entry, "ls", "--json"], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);

    const q = Bun.spawn(["bun", entry, "ls", "--json"], { env: { PATH: process.env.PATH ?? "", HOME: home, SEKI_TOKEN: "wrong" }, stdout: "pipe", stderr: "pipe" });
    expect(await q.exited).toBe(2);
  });
});
