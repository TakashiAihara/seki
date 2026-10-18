import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type Server } from "./helpers/server";

const entry = join(import.meta.dir, "..", "src", "index.ts");

let s: Server;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.stop();
});

type Run = { code: number; out: string; err: string };

// HOME points at an empty dir so a real ~/.config/seki on the test machine is never read.
async function seki(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "seki-home-"));
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

  test("without --holder or SEKI_HOLDER the holder is user@host", async () => {
    await seki(["acquire", "c5", "--shared"], { SEKI_HOLDER: undefined, USER: "frank" });
    expect((await ls()).find((x) => x.resource === "c5")?.holder).toBe(`frank@${hostname()}`);
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

  test("the default ttl is one hour", async () => {
    const before = Date.now();
    await seki(["acquire", "c6", "--shared"]);
    const l = (await ls()).find((x) => x.resource === "c6")!;
    expect(Math.round((l.expires_at - before) / 60000)).toBe(60);
  });

  test("renew moves the expiry of the caller's own lease", async () => {
    await seki(["acquire", "c7", "--exclusive", "--ttl", "60"]);
    expect((await seki(["renew", "c7", "--exclusive", "--ttl", "2h"])).code).toBe(0);
    const l = (await ls()).find((x) => x.resource === "c7")!;
    expect(l.expires_at - Date.now()).toBeGreaterThan(3600 * 1000);
  });
});

describe("usage errors exit 2", () => {
  test.each([
    [["acquire", "u1"]],
    [["acquire", "u1", "--shared", "--exclusive"]],
    [["acquire", "--shared"]],
    [["acquire", "u1", "--shared", "--ttl", "soon"]],
    [["acquire", "u1", "--shared", "--ttl", "0"]],
    [["run", "u1", "--shared"]],
    [["frobnicate"]],
  ])("%j", async (args) => {
    expect((await seki(args)).code).toBe(2);
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
    const dir = mkdtempSync(join(tmpdir(), "seki-run-"));
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
    const dir = mkdtempSync(join(tmpdir(), "seki-run-"));
    const marker = join(dir, "late");
    const running = seki(["run", "x3", "--exclusive", "--ttl", "2s", "--", "sh", "-c", `sleep 3.5; touch ${marker}; sleep 1`], { SEKI_HOLDER: "long" });
    for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    expect((await seki(["acquire", "x3", "--exclusive"], { SEKI_HOLDER: "other" })).code).toBe(1);
    expect((await running).code).toBe(0);
  });

  test("does not run the command when the resource is held, and exits 1", async () => {
    await seki(["acquire", "x4", "--exclusive"], { SEKI_HOLDER: "owner" });
    const dir = mkdtempSync(join(tmpdir(), "seki-run-"));
    const marker = join(dir, "ran");
    const r = await seki(["run", "x4", "--exclusive", "--", "touch", marker], { SEKI_HOLDER: "intruder" });
    expect(r.code).toBe(1);
    expect(existsSync(marker)).toBe(false);
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

  test("server unreachable", async () => {
    expect((await seki(["acquire", "f2", "--shared"], { SEKI_URL: "http://127.0.0.1:9" })).code).toBe(2);
  });

  test("run does not start the command when the server is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seki-run-"));
    const marker = join(dir, "ran");
    const r = await seki(["run", "f3", "--shared", "--", "touch", marker], { SEKI_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  test("the config file supplies url and a token_command; env wins over the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "seki-cfg-"));
    mkdirSync(join(home, ".config", "seki"), { recursive: true });
    writeFileSync(join(home, ".config", "seki", "config.json"), JSON.stringify({ url: s.url, token_command: `printf %s ${s.token}` }));
    const p = Bun.spawn(["bun", entry, "ls", "--json"], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);

    const q = Bun.spawn(["bun", entry, "ls", "--json"], { env: { PATH: process.env.PATH ?? "", HOME: home, SEKI_TOKEN: "wrong" }, stdout: "pipe", stderr: "pipe" });
    expect(await q.exited).toBe(2);
  });
});
