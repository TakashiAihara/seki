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

type Lease = { resource: string; holder: string; mode: string; host: string; why: string; expires_at: number };
async function ls(): Promise<Lease[]> {
  const r = await seki(["ls", "--json"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as Lease[];
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
    expect(r.err).toContain("SEKI_HOLDER");
    expect((await ls()).some((x) => x.resource === "c5")).toBe(false);
  });

  test("release without --holder or SEKI_HOLDER is refused", async () => {
    expect((await seki(["release", "c5"], { SEKI_HOLDER: undefined, USER: "frank" })).code).toBe(2);
  });

  test("a holder in the config file is not used", async () => {
    const home = tempDir("seki-cfg-");
    mkdirSync(join(home, ".config", "seki"), { recursive: true });
    writeFileSync(join(home, ".config", "seki", "config.json"), JSON.stringify({ url: s.url, token: s.token, holder: "from-file" }));
    const p = Bun.spawn(["bun", entry, "acquire", "c5b", "--shared"], { env: { PATH: process.env.PATH ?? "", HOME: home, USER: "frank" }, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(2);
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
    expect(r.err).toContain("3");
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
    await seki(["release", "r2"], { SEKI_HOLDER: "b" });
    expect((await ls()).some((x) => x.resource === "r2" && x.holder === "a")).toBe(true);
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

  test("two runs on the same host without SEKI_HOLDER do not share an exclusive lease", async () => {
    const marker = join(tempDir("seki-run-"), "started");
    const first = seki(["run", "x8", "--exclusive", "--", "sh", "-c", `touch ${marker}; sleep 2`], { SEKI_HOLDER: undefined, USER: "same" });
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    const second = await seki(["run", "x8", "--exclusive", "--", "true"], { SEKI_HOLDER: undefined, USER: "same" });
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

  test("a command exiting 1, 2, 124 or 125 on its own is passed through as is", async () => {
    for (const c of [1, 2, 124, 125]) expect((await seki(["run", `x9-${c}`, "--shared", "--", "sh", "-c", `exit ${c}`])).code).toBe(c);
  });

  test("when another holder takes the lease over, the command is stopped and run exits 124", async () => {
    const marker = join(tempDir("seki-run-"), "started");
    const running = seki(["run", "x10", "--exclusive", "--ttl", "3s", "--holder", "victim", "--", "sh", "-c", `touch ${marker}; exec sleep 20`]);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    await seki(["release", "x10"], { SEKI_HOLDER: "victim" });
    expect((await seki(["acquire", "x10", "--exclusive"], { SEKI_HOLDER: "thief" })).code).toBe(0);
    const started = Date.now();
    const r = await running;
    expect(r.code).toBe(124);
    expect(r.err).toContain("thief");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("when renews keep failing until the lease has lapsed, the command is stopped and run exits 124", async () => {
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
    try {
      const started = Date.now();
      const r = await seki(["run", "x11", "--exclusive", "--ttl", "3s", "--", "sleep", "20"], { SEKI_URL: `http://127.0.0.1:${proxy.port}` });
      expect(r.code).toBe(124);
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      proxy.stop(true);
    }
  });

  test("SIGINT to seki alone is not forwarded: seki waits for the command, then releases", async () => {
    const dir = tempDir("seki-run-");
    const marker = join(dir, "started");
    const done = join(dir, "done");
    const home = tempDir("seki-home-");
    const p = Bun.spawn(["bun", entry, "run", "x12", "--exclusive", "--", "sh", "-c", `touch ${marker}; sleep 1; touch ${done}`], { env: { PATH: process.env.PATH ?? "", HOME: home, SEKI_URL: s.url, SEKI_TOKEN: s.token, SEKI_HOLDER: "intr" }, stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    p.kill("SIGINT");
    expect(await p.exited).toBe(0);
    expect(existsSync(done)).toBe(true);
    expect((await ls()).some((x) => x.resource === "x12")).toBe(false);
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
