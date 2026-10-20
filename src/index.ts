import { readFile } from "node:fs/promises";
import { constants, homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

declare const SEKI_VERSION: string;

const version = typeof SEKI_VERSION === "undefined" ? "dev" : SEKI_VERSION;

type Mode = "shared" | "exclusive";

type Lease = { resource: string; holder: string; mode: Mode; host: string; why: string; expires_at: number };

type Waiter = { resource: string; holder: string; mode: Mode; host: string; why: string; queued_at: number; expires_at: number; position: number };

type FileConfig = { url?: string; token?: string; token_command?: string };

type Config = { url: string; token: string };

type LeaseOpts = { shared?: boolean; exclusive?: boolean; ttl: number; why?: string; holder?: string; wait?: number };

type Reply = { status: number; text: string };

// Carries the exit code out of the command body; main turns it into the process exit code.
class Failure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class Unreachable extends Failure {
  constructor(message: string) {
    super(2, message);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadFileConfig(): Promise<FileConfig> {
  const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "seki", "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    throw new Failure(2, `cannot read ${path}: ${errText(e)}`);
  }
  try {
    return JSON.parse(text) as FileConfig;
  } catch (e) {
    throw new Failure(2, `cannot parse ${path}: ${errText(e)}`);
  }
}

async function runTokenCommand(command: string): Promise<string> {
  const p = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Failure(2, "token_command failed");
  return out.trim();
}

async function resolveToken(file: FileConfig): Promise<string> {
  if (process.env.SEKI_TOKEN) return process.env.SEKI_TOKEN;
  if (file.token) return file.token;
  if (file.token_command) {
    const token = await runTokenCommand(file.token_command);
    if (token) return token;
  }
  throw new Failure(2, "SEKI_TOKEN is not set (env SEKI_TOKEN, token or token_command in the config file)");
}

async function connect(file: FileConfig): Promise<Config> {
  timeoutMs = envMs("SEKI_TIMEOUT_MS", 10_000, 1);
  const url = process.env.SEKI_URL || file.url;
  if (!url) throw new Failure(2, "SEKI_URL is not set (env SEKI_URL or url in the config file)");
  return { url, token: await resolveToken(file) };
}

// There is no default holder for acquire / release: every session of the
// same user on one host would share it, and the second exclusive acquire would
// renew the first one's lease instead of being refused.
function resolveHolder(flag: string | undefined): string {
  const holder = flag || process.env.SEKI_HOLDER;
  if (holder) return holder;
  throw new Failure(2, "set --holder or SEKI_HOLDER: two callers with the same holder share one lease");
}

// run takes and releases its own lease, so its holder is always made unique to the
// invocation: two runs of one session (same SEKI_HOLDER) must not share a lease.
function runHolder(flag: string | undefined): string {
  const base = flag || process.env.SEKI_HOLDER || `${process.env.USER || "unknown"}@${hostname()}`;
  return `${base}#${crypto.randomUUID().slice(0, 8)}`;
}

const MAX_TTL_SEC = 7 * 24 * 3600;
const MIN_TTL_SEC = 3;

function modeOf(o: LeaseOpts): Mode {
  if (o.shared) return "shared";
  if (o.exclusive) return "exclusive";
  throw new Failure(2, "one of --shared or --exclusive is required");
}

function parseDuration(value: string): number {
  const m = /^([1-9]\d*)([smh]?)$/.exec(value);
  if (!m) throw new InvalidArgumentError(`takes 90s, 30m, 6h or a number of seconds, got "${value}"`);
  const unit = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  const sec = Number(m[1]) * unit;
  if (sec > MAX_TTL_SEC) throw new InvalidArgumentError(`is at most 7 days (168h), got "${value}"`);
  return sec;
}

function parseTtl(value: string): number {
  const sec = parseDuration(value);
  // run renews every third of the ttl; below 3 s that is under a second apart and one failed renew lapses the lease.
  if (sec < MIN_TTL_SEC) throw new InvalidArgumentError(`is at least ${MIN_TTL_SEC}s, got "${value}"`);
  return sec;
}

// An unusable value is refused, not replaced by the default: SEKI_TIMEOUT_MS=0 or
// SEKI_KILL_AFTER_MS=-1 is a mistake the caller should hear about.
function envMs(name: string, fallback: number, min: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min) throw new Failure(2, `${name} must be an integer >= ${min} (milliseconds), got "${v}"`);
  return n;
}

let timeoutMs = 10_000;

async function call(cfg: Config, method: "GET" | "POST", path: string, body?: unknown, limitMs = timeoutMs): Promise<Reply> {
  try {
    const res = await fetch(cfg.url.replace(/\/+$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(limitMs),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Unreachable(`server unreachable at ${cfg.url}: ${errText(e)}`);
  }
}

function parseReply<T>(r: Reply): T {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new Failure(2, `unexpected response (HTTP ${r.status}): ${r.text}`);
  }
}

function expectStatus<T>(r: Reply, status: number): T {
  if (r.status !== status) throw new Failure(2, `server returned ${r.status}: ${r.text}`);
  return parseReply<T>(r);
}

type AcquireBody = { resource: string; holder: string; mode: Mode; ttl_sec: number; host: string; why?: string; renew?: boolean; queue_ttl_sec?: number };

type AcquireResult = { lease: Lease; renewed: boolean } | { heldBy: Lease[]; waiting: Waiter[]; position?: number } | { gone: true };

async function acquire(cfg: Config, body: AcquireBody, limitMs = timeoutMs): Promise<AcquireResult> {
  // The server drops a request it sees after we stopped waiting, so giving up never leaves a lease behind.
  const r = await call(cfg, "POST", "/api/seki/acquire", { ...body, not_after: Date.now() + Math.ceil(limitMs) }, limitMs);
  // A proxy in front of a restarting server; worth asking again while waiting.
  if (r.status === 502 || r.status === 504) throw new Unreachable(`server returned ${r.status}: ${r.text}`);
  const data = parseReply<{ lease?: Lease; renewed?: boolean; held_by?: Lease[]; waiting?: Waiter[]; position?: number }>(r);
  // run needs to know a renew from a fresh lease; a server that does not say is too old to trust with it.
  if (r.status === 200 && data.lease && typeof data.renewed !== "boolean") {
    throw new Failure(2, "the server's acquire answer has no `renewed`; update the seki server");
  }
  if (r.status === 200 && data.lease) return { lease: data.lease, renewed: data.renewed === true };
  if (r.status === 409 && data.held_by) return { heldBy: data.held_by, waiting: data.waiting ?? [], position: data.position };
  if (r.status === 410 && body.renew) return { gone: true };
  if (r.status === 408) {
    const serverNow = parseReply<{ server_now?: number }>(r).server_now;
    const skew = typeof serverNow === "number" ? `; server clock minus this host's: ${serverNow - Date.now()} ms` : "";
    throw new Failure(2, `the server got the request after this client stopped waiting for it, or the two clocks differ${skew}`);
  }
  throw new Failure(2, `server returned ${r.status}: ${r.text}`);
}

async function release(cfg: Config, resource: string, holder: string): Promise<number> {
  const r = await call(cfg, "POST", "/api/seki/release", { resource, holder });
  return expectStatus<{ released: number }>(r, 200).released;
}

async function dropLease(cfg: Config, resource: string, holder: string): Promise<void> {
  try {
    await release(cfg, resource, holder);
  } catch (e) {
    console.error(`warning: could not release ${resource}: ${errText(e)}; it expires on its own`);
  }
}

async function unqueue(cfg: Config, resource: string, holder: string): Promise<void> {
  try {
    expectStatus(await call(cfg, "POST", "/api/seki/unqueue", { resource, holder }), 200);
  } catch (e) {
    console.error(`warning: could not leave the queue for ${resource}: ${errText(e)}; it drops out on its own`);
  }
}

const POLL_MS = 1000;

// How long the server keeps a waiter that stops asking. Two refreshes the server sees can be
// up to 2 × SEKI_TIMEOUT_MS + POLL_MS apart (an answer that takes the whole timeout, the
// sleep, then a request that does too), so slow answers do not cost the place in the queue.
function queueTtlSec(): number {
  return Math.min(3600, Math.ceil((2 * timeoutMs + POLL_MS) / 1000) + 20);
}

// With waitMs > 0 a refused request is queued and asked again every POLL_MS, keeping its
// place, until the lease is taken or waitMs has passed (then it leaves the queue).
// sentAt is when the answered request left, for run's lease clock.
async function acquireWaiting(cfg: Config, body: AcquireBody, waitMs: number): Promise<{ result: AcquireResult; sentAt: number }> {
  if (waitMs === 0) {
    const sentAt = performance.now();
    return { result: await acquire(cfg, body), sentAt };
  }
  const until = performance.now() + waitMs;
  const queued = { ...body, queue_ttl_sec: queueTtlSec() };
  let shown: number | undefined;
  let answered = false;
  let failing = false;
  try {
    for (;;) {
      const sentAt = performance.now();
      let result: AcquireResult;
      try {
        result = await acquire(cfg, queued);
      } catch (e) {
        // A wait can last hours; a dropped connection or a server restart behind a proxy should
        // not end it. Before the first answer the address may simply be wrong, and other errors
        // (token, clock, usage) are not ones that clear up, so those end the wait at once.
        if (!answered || !(e instanceof Unreachable) || performance.now() >= until) throw e;
        if (!failing) console.error(`warning: ${e.message}; asking again`);
        failing = true;
        await Bun.sleep(Math.min(POLL_MS, until - performance.now()));
        continue;
      }
      answered = true;
      failing = false;
      if (!("heldBy" in result)) return { result, sentAt };
      if (performance.now() >= until) {
        await unqueue(cfg, body.resource, body.holder);
        return { result, sentAt };
      }
      if (result.position !== shown) {
        shown = result.position;
        console.error(`seki: waiting for ${body.resource}: number ${shown} in the queue`);
      }
      await Bun.sleep(Math.min(POLL_MS, until - performance.now()));
    }
  } catch (e) {
    await unqueue(cfg, body.resource, body.holder);
    throw e;
  }
}

async function listLeases(cfg: Config): Promise<{ leases: Lease[]; waiting: Waiter[] }> {
  const r = await call(cfg, "GET", "/api/seki/leases");
  const data = expectStatus<{ leases: Lease[]; waiting?: Waiter[] }>(r, 200);
  return { leases: data.leases, waiting: data.waiting ?? [] };
}

function heldMessage(resource: string, heldBy: Lease[], waiting: Waiter[] = []): string {
  const held = heldBy.map(
    (l) =>
      `  ${l.mode} by ${l.holder} on ${l.host} until ${new Date(l.expires_at).toISOString()}${l.why ? ` (${l.why})` : ""}`,
  );
  const queued = waiting.map(
    (w) =>
      `  ${w.position}. ${w.mode} by ${w.holder} on ${w.host} since ${new Date(w.queued_at).toISOString()}${w.why ? ` (${w.why})` : ""}`,
  );
  return [
    ...(held.length > 0 ? [`${resource} is held:`, ...held] : []),
    ...(queued.length > 0 ? [`waiting for ${resource} ahead of this request:`, ...queued] : []),
  ].join("\n");
}

// Every column but the last is padded; the last (free text) is left as is.
function table(rows: string[][]): string {
  const widths = rows[0]!.slice(0, -1).map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => r.map((c, i) => (i < widths.length ? c.padEnd(widths[i]!) : c)).join("  ").trimEnd())
    .join("\n");
}

function formatTable(leases: Lease[], waiting: Waiter[]): string {
  const now = Date.now();
  const minutes = (ms: number) => `${Math.max(0, Math.floor(ms / 60000))}m`;
  const held = table([
    ["RESOURCE", "MODE", "HOLDER", "HOST", "EXPIRES", "WHY"],
    ...leases.map((l) => [l.resource, l.mode, l.holder, l.host, `in ${minutes(l.expires_at - now)}`, l.why]),
  ]);
  if (waiting.length === 0) return held;
  const queued = table([
    ["RESOURCE", "POS", "MODE", "HOLDER", "HOST", "WAITING", "WHY"],
    ...waiting.map((w) => [w.resource, String(w.position), w.mode, w.holder, w.host, `for ${minutes(now - w.queued_at)}`, w.why]),
  ]);
  return `${held}\n\n${queued}`;
}

async function acquireCmd(resource: string, o: LeaseOpts): Promise<number> {
  const mode = modeOf(o);
  const holder = resolveHolder(o.holder);
  const cfg = await connect(await loadFileConfig());
  const { result: r } = await acquireWaiting(cfg, { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why }, (o.wait ?? 0) * 1000);
  if ("heldBy" in r) throw new Failure(1, heldMessage(resource, r.heldBy, r.waiting));
  if (!("lease" in r)) throw new Failure(2, "unexpected answer from the server");
  console.log(`acquired ${resource} ${mode} until ${new Date(r.lease.expires_at).toISOString()}`);
  return 0;
}

async function releaseCmd(resource: string, o: { holder?: string }): Promise<number> {
  const holder = resolveHolder(o.holder);
  const cfg = await connect(await loadFileConfig());
  const n = await release(cfg, resource, holder);
  console.log(n > 0 ? `released ${resource}` : `not held ${resource}`);
  return 0;
}

async function lsCmd(o: { json?: boolean }): Promise<number> {
  const cfg = await connect(await loadFileConfig());
  const { leases, waiting } = await listLeases(cfg);
  console.log(o.json ? JSON.stringify({ leases, waiting }, null, 2) : formatTable(leases, waiting));
  return 0;
}

// run's own outcomes, kept out of the range a command normally uses for itself
// (the command's own code is passed through; see the README's exit code table).
const RUN_HELD = 124;
const RUN_LOST = 123;
const RUN_FAILED = 125;
const RUN_NOT_EXECUTABLE = 126;
const RUN_NOT_FOUND = 127;


async function runCmd(resource: string, command: string[], o: LeaseOpts): Promise<number> {
  const mode = modeOf(o);
  const killAfterMs = envMs("SEKI_KILL_AFTER_MS", 10_000, 0);
  const holder = runHolder(o.holder);
  const cfg = await connect(await loadFileConfig());
  const body: AcquireBody = { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why };

  // performance.now() is monotonic: a wall-clock step cannot stretch the lease.
  let first: AcquireResult;
  let sentAt: number;
  try {
    ({ result: first, sentAt } = await acquireWaiting(cfg, body, (o.wait ?? 0) * 1000));
  } catch (e) {
    // The server may have created the lease before the answer turned out unusable.
    await dropLease(cfg, resource, holder);
    throw e;
  }
  if ("heldBy" in first) throw new Failure(RUN_HELD, heldMessage(resource, first.heldBy, first.waiting));
  // Counted from when the request left, so a slow answer cannot make the lease look longer than it is.
  let validUntil = sentAt + o.ttl * 1000;
  // Less than one renew interval left: the first renew might not land in time.
  if (validUntil - performance.now() < (o.ttl * 1000) / 3) {
    await dropLease(cfg, resource, holder);
    throw new Failure(RUN_FAILED, `the server answered too late (under a third of the ${o.ttl}s lease left); not starting the command`);
  }

  // Its own session and process group, so the whole command (background children
  // included) can be signalled at once, and the terminal's signals reach seki, which
  // passes them on.
  let child: Subprocess;
  try {
    child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
  } catch (e) {
    await dropLease(cfg, resource, holder);
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") throw new Failure(RUN_NOT_FOUND, `${command[0]}: not found`);
    if (code === "EACCES") throw new Failure(RUN_NOT_EXECUTABLE, `${command[0]}: not executable`);
    throw new Failure(RUN_FAILED, `cannot start ${command[0]}: ${errText(e)}`);
  }
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };

  // Losing the lease stops the command: whoever holds it now was told the resource is theirs.
  // A group that is still there killAfterMs after SIGTERM gets SIGKILL.
  let lost: string | undefined;
  let lostAt = 0;
  let killer: Timer | undefined;
  const loseLease = (why: string) => {
    if (lost) return;
    lost = why;
    lostAt = performance.now();
    console.error(`seki: lost the lease on ${resource}: ${why}; stopping the command`);
    signalGroup("SIGTERM");
    killer = setTimeout(() => signalGroup("SIGKILL"), killAfterMs);
  };

  // The deadline fires at the lease's own expiry, whatever the renews are doing; a renew
  // that hangs cannot keep the command running past it.
  const lapsed = () => loseLease("the lease lapsed before a renew got through");
  let deadline = setTimeout(lapsed, validUntil - performance.now());

  // A third of the ttl: one renew can fail and the next still lands before expiry.
  // One renew at a time, each cut off when the lease would lapse anyway; the release waits
  // for it so the last word the server hears from this run is the release.
  let renewing: Promise<void> | undefined;
  const renew = setInterval(() => {
    if (lost || renewing) return;
    renewing = (async () => {
      const sent = performance.now();
      try {
        const r = await acquire(cfg, { ...body, renew: true }, Math.min(timeoutMs, Math.max(1, validUntil - sent)));
        if ("heldBy" in r) return loseLease(heldMessage(resource, r.heldBy));
        if ("gone" in r) return loseLease("the server no longer had the lease when the renew arrived");
        // A new lease instead of a renewed one means ours ran out on the server in between,
        // and someone else may have held the resource meanwhile.
        if (!r.renewed) return loseLease("the server no longer had the lease when the renew arrived");
        validUntil = sent + o.ttl * 1000;
        clearTimeout(deadline);
        deadline = setTimeout(lapsed, validUntil - performance.now());
      } catch (e) {
        if (!lost) console.error(`warning: renew ${resource} failed: ${errText(e)}`);
      } finally {
        renewing = undefined;
      }
    })();
  }, (o.ttl * 1000) / 3);

  // The command is no longer in the terminal's process group, so a Ctrl-C or a hangup
  // reaches seki only; all three are passed on to the command's group. The handlers stay
  // until the lease is released, so a second signal cannot cut the release short.
  const forward = (sig: NodeJS.Signals) => signalGroup(sig);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  for (const s of signals) process.on(s, forward);
  let groupGone = true;
  try {
    await child.exited;
    // The leader is gone, but other processes of the group may not be; none may keep
    // the resource past the release. After a lost lease they get what is left of the
    // grace period that started with its SIGTERM.
    const grace = lost ? Math.max(0, killAfterMs - (performance.now() - lostAt)) : killAfterMs;
    groupGone = await drainGroup(child.pid, grace);
  } finally {
    clearInterval(renew);
    clearTimeout(deadline);
    if (killer) clearTimeout(killer);
    await renewing;
    // Released lost or not: the holder is unique to this run, so this only drops what this
    // run holds. Not released while part of the command is still alive: the lease then
    // runs out on its own instead of being handed to the next holder early.
    if (groupGone) await dropLease(cfg, resource, holder);
    else console.error(`warning: part of the command is still running after SIGKILL; leaving ${resource} to expire instead of releasing it`);
    for (const s of signals) process.off(s, forward);
  }

  if (lost) throw new Failure(RUN_LOST, "");
  const code = child.exitCode;
  if (code !== null) return code;
  const sig = child.signalCode;
  if (typeof sig !== "string") throw new Failure(RUN_FAILED, "child exited without a code or a signal");
  return 128 + constants.signals[sig];
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM to what is left of the group, SIGKILL after graceMs, and wait until it is empty.
// Returns whether the group is gone.
async function drainGroup(pgid: number, graceMs: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pgid, sig);
    } catch {}
  };
  signal(graceMs > 0 ? "SIGTERM" : "SIGKILL");
  const until = performance.now() + graceMs;
  while (groupAlive(pgid) && performance.now() < until) await Bun.sleep(50);
  if (!groupAlive(pgid)) return true;
  signal("SIGKILL");
  for (let i = 0; i < 40 && groupAlive(pgid); i++) await Bun.sleep(50);
  return !groupAlive(pgid);
}

const valueOptions = new Set(["--holder", "--ttl", "--why", "--wait"]);

// The index of the -- that ends seki's own arguments, skipping the values of options
// that take one (in `--why -- -- cmd` the first -- is the reason).
function separatorIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--") return i;
    if (valueOptions.has(argv[i]!)) i++;
  }
  return -1;
}

function addHolder(c: Command): Command {
  return c.option("--holder <name>", "holder name; default $SEKI_HOLDER");
}

function addLeaseOptions(c: Command): Command {
  return addHolder(c)
    .addOption(new Option("--shared", "several shared holders may coexist").conflicts("exclusive"))
    .addOption(new Option("--exclusive", "no other holder while this one is held").conflicts("shared"))
    .addOption(
      new Option("--ttl <duration>", "90s, 30m, 6h or a number of seconds").argParser(parseTtl).default(600, "10m"),
    )
    .option("--why <text>", "reason shown to other holders")
    .addOption(
      new Option("--wait <duration>", "if it is held, queue up and wait this long for it (90s, 30m, 6h)").argParser(parseDuration),
    );
}

async function main(argv: string[]): Promise<number> {
  let code = 0;
  // Set by the run action, so a usage error inside run is reported with run's codes.
  let inRun = false;

  const program = new Command()
    .name("seki")
    .description("shared / exclusive leases with TTL for resources that several agents or hosts contend for")
    .version(version)
    .exitOverride();

  addLeaseOptions(program.command("acquire").description("take a lease, or extend your own").argument("<resource>")).action(
    async (resource: string, o: LeaseOpts) => {
      code = await acquireCmd(resource, o);
    },
  );

  addHolder(program.command("release").description("drop a lease you hold").argument("<resource>")).action(
    async (resource: string, o: { holder?: string }) => {
      code = await releaseCmd(resource, o);
    },
  );

  program
    .command("ls")
    .description("list live leases")
    .option("--json", "print the leases as JSON")
    .action(async (o: { json?: boolean }) => {
      code = await lsCmd(o);
    });

  const run = addLeaseOptions(
    program.command("run").description("hold a lease while a command runs").argument("<resource>").argument("<command...>"),
  )
    .action(async (resource: string, command: string[], o: LeaseOpts) => {
      inRun = true;
      const sep = separatorIndex(argv);
      if (sep < 0 || argv.slice(sep + 1).join("\0") !== command.join("\0")) {
        throw new Failure(2, "put -- before the command: seki run <resource> --shared -- <command>");
      }
      code = await runCmd(resource, command, o);
    });
  run.exitOverride((e) => {
    inRun = true;
    throw e;
  });

  // Failures that are not run's own codes (usage, config, server) become 125 under run.
  const asRun = (c: number) => (c === 0 || c >= RUN_LOST ? c : RUN_FAILED);
  const finish = (c: number) => (inRun ? asRun(c) : c);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return finish(e.exitCode === 0 ? 0 : 2);
    if (e instanceof Failure) {
      if (e.message) console.error(e.message);
      return finish(e.code);
    }
    console.error(`seki: unexpected error: ${errText(e)}`);
    return finish(2);
  }
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
