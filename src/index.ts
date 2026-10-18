import { readFile } from "node:fs/promises";
import { constants, homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

declare const SEKI_VERSION: string;

const version = typeof SEKI_VERSION === "undefined" ? "dev" : SEKI_VERSION;

type Mode = "shared" | "exclusive";

type Lease = { resource: string; holder: string; mode: Mode; host: string; why: string; expires_at: number };

type FileConfig = { url?: string; token?: string; token_command?: string };

type Config = { url: string; token: string };

type LeaseOpts = { shared?: boolean; exclusive?: boolean; ttl: number; why?: string; holder?: string };

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
  const url = process.env.SEKI_URL || file.url;
  if (!url) throw new Failure(2, "SEKI_URL is not set (env SEKI_URL or url in the config file)");
  return { url, token: await resolveToken(file) };
}

// There is no default holder for acquire / renew / release: every session of the
// same user on one host would share it, and the second exclusive acquire would
// renew the first one's lease instead of being refused.
function resolveHolder(flag: string | undefined): string {
  const holder = flag || process.env.SEKI_HOLDER;
  if (holder) return holder;
  throw new Failure(2, "set --holder or SEKI_HOLDER: two callers with the same holder share one lease");
}

// run owns its lease from start to end, so a name unique to this invocation is safe.
function runHolder(flag: string | undefined): string {
  return flag || process.env.SEKI_HOLDER || `${process.env.USER || "unknown"}@${hostname()}#${crypto.randomUUID().slice(0, 8)}`;
}

const MAX_TTL_SEC = 7 * 24 * 3600;
const MIN_TTL_SEC = 3;

function modeOf(o: LeaseOpts): Mode {
  if (o.shared) return "shared";
  if (o.exclusive) return "exclusive";
  throw new Failure(2, "one of --shared or --exclusive is required");
}

function parseTtl(value: string): number {
  const m = /^([1-9]\d*)([smh]?)$/.exec(value);
  if (!m) throw new InvalidArgumentError(`takes 90s, 30m, 6h or a number of seconds, got "${value}"`);
  const unit = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  const sec = Number(m[1]) * unit;
  if (sec > MAX_TTL_SEC) throw new InvalidArgumentError(`is at most 7 days (168h), got "${value}"`);
  // run renews every third of the ttl; below 3 s that is under a second apart and one failed renew lapses the lease.
  if (sec < MIN_TTL_SEC) throw new InvalidArgumentError(`is at least ${MIN_TTL_SEC}s, got "${value}"`);
  return sec;
}

const timeoutMs = Number(process.env.SEKI_TIMEOUT_MS) || 10_000;

async function call(cfg: Config, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(cfg.url.replace(/\/+$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new Failure(2, `server unreachable at ${cfg.url}: ${errText(e)}`);
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

type AcquireBody = { resource: string; holder: string; mode: Mode; ttl_sec: number; host: string; why?: string };

type AcquireResult = { lease: Lease } | { heldBy: Lease[] };

async function acquire(cfg: Config, body: AcquireBody): Promise<AcquireResult> {
  const r = await call(cfg, "POST", "/api/seki/acquire", body);
  const data = parseReply<{ lease?: Lease; held_by?: Lease[] }>(r);
  if (r.status === 200 && data.lease) return { lease: data.lease };
  if (r.status === 409 && data.held_by) return { heldBy: data.held_by };
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

async function listLeases(cfg: Config): Promise<Lease[]> {
  const r = await call(cfg, "GET", "/api/seki/leases");
  return expectStatus<{ leases: Lease[] }>(r, 200).leases;
}

function heldMessage(resource: string, heldBy: Lease[]): string {
  const lines = heldBy.map(
    (l) =>
      `  ${l.mode} by ${l.holder} on ${l.host} until ${new Date(l.expires_at).toISOString()}${l.why ? ` (${l.why})` : ""}`,
  );
  return [`${resource} is held:`, ...lines].join("\n");
}

function formatTable(leases: Lease[]): string {
  const now = Date.now();
  const rows: string[][] = [
    ["RESOURCE", "MODE", "HOLDER", "HOST", "EXPIRES", "WHY"],
    ...leases.map((l) => [
      l.resource,
      l.mode,
      l.holder,
      l.host,
      `in ${Math.max(0, Math.floor((l.expires_at - now) / 60000))}m`,
      l.why,
    ]),
  ];
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => r.map((c, i) => (i < widths.length ? c.padEnd(widths[i]!) : c)).join("  ").trimEnd())
    .join("\n");
}

async function acquireCmd(resource: string, o: LeaseOpts): Promise<number> {
  const mode = modeOf(o);
  const holder = resolveHolder(o.holder);
  const cfg = await connect(await loadFileConfig());
  const r = await acquire(cfg, { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why });
  if ("heldBy" in r) throw new Failure(1, heldMessage(resource, r.heldBy));
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
  const leases = await listLeases(cfg);
  console.log(o.json ? JSON.stringify(leases, null, 2) : formatTable(leases));
  return 0;
}

async function runCmd(resource: string, command: string[], o: LeaseOpts): Promise<number> {
  const mode = modeOf(o);
  const holder = runHolder(o.holder);
  const cfg = await connect(await loadFileConfig());
  const body: AcquireBody = { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why };

  const sentAt = Date.now();
  const first = await acquire(cfg, body);
  if ("heldBy" in first) throw new Failure(1, heldMessage(resource, first.heldBy));
  // Counted from when the request left, so a slow answer cannot make the lease look longer than it is.
  let validUntil = sentAt + o.ttl * 1000;

  let child: Subprocess;
  try {
    child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    await dropLease(cfg, resource, holder);
    throw new Failure(2, `cannot start ${command[0]}: ${errText(e)}`);
  }

  // Losing the lease stops the command: whoever holds it now was told the resource is theirs.
  let lost: string | undefined;
  const loseLease = (why: string) => {
    if (lost) return;
    lost = why;
    console.error(`seki: lost the lease on ${resource}: ${why}; stopping the command`);
    child.kill("SIGTERM");
  };

  // A third of the ttl: one renew can fail and the next still lands before expiry.
  // Renews are chained so they never overlap, and the release waits for the last
  // one: a renew still on the wire would otherwise recreate the lease after it.
  let renewing: Promise<void> = Promise.resolve();
  const renew = setInterval(() => {
    renewing = renewing.then(async () => {
      if (lost) return;
      const sent = Date.now();
      try {
        const r = await acquire(cfg, body);
        if ("heldBy" in r) return loseLease(heldMessage(resource, r.heldBy));
        validUntil = sent + o.ttl * 1000;
      } catch (e) {
        if (Date.now() >= validUntil) return loseLease(`renew failed until the lease lapsed (${errText(e)})`);
        console.error(`warning: renew ${resource} failed: ${errText(e)}`);
      }
    });
  }, (o.ttl * 1000) / 3);

  // A Ctrl-C from the terminal already reaches the child (same process group), so SIGINT is
  // not forwarded; seki only stays alive to release after the child exits. SIGTERM and SIGHUP
  // are addressed to seki alone and are passed on.
  const ignore = () => {};
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  try {
    await child.exited;
  } finally {
    clearInterval(renew);
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    await renewing;
    await dropLease(cfg, resource, holder);
  }

  if (lost) throw new Failure(1, "");
  const code = child.exitCode;
  if (code !== null) return code;
  const sig = child.signalCode;
  if (typeof sig !== "string") throw new Failure(2, "child exited without a code or a signal");
  return 128 + constants.signals[sig];
}

const valueOptions = new Set(["--holder", "--ttl", "--why"]);

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
    .option("--why <text>", "reason shown to other holders");
}

async function main(argv: string[]): Promise<number> {
  let code = 0;

  const program = new Command()
    .name("seki")
    .description("shared / exclusive leases with TTL for resources that several agents or hosts contend for")
    .version(version)
    .exitOverride();

  const lease = async (resource: string, o: LeaseOpts) => {
    code = await acquireCmd(resource, o);
  };
  addLeaseOptions(program.command("acquire").description("take a lease, or extend your own").argument("<resource>")).action(lease);

  addHolder(program.command("release").description("drop a lease you hold").argument("<resource>")).action(
    async (resource: string, o: { holder?: string }) => {
      code = await releaseCmd(resource, o);
    },
  );

  program.command("ls").description("list live leases")
    .option("--json", "print the leases as JSON")
    .action(async (o: { json?: boolean }) => {
      code = await lsCmd(o);
    });

  addLeaseOptions(
    program.command("run").description("hold a lease while a command runs").argument("<resource>").argument("<command...>"),
  ).action(async (resource: string, command: string[], o: LeaseOpts) => {
    // Commander drops the -- separator. The command must be exactly what follows the first
    // bare -- that is not the value of an option taking one (--why -- reads "--" as the reason).
    let sep = argv.indexOf("--");
    while (sep > 0 && valueOptions.has(argv[sep - 1]!)) sep = argv.indexOf("--", sep + 1);
    if (sep < 0 || argv.slice(sep + 1).join("\0") !== command.join("\0")) {
      throw new Failure(2, "put -- before the command: seki run <resource> --shared -- <command>");
    }
    code = await runCmd(resource, command, o);
  });

  // run passes the command's exit code through, so its own outcomes move out of the way:
  // 124 = held or lost (as timeout(1) uses 124), 125 = seki failed (as env(1) uses 125).
  const own = (c: number) => (argv[0] !== "run" || c === 0 ? c : c === 1 ? 124 : 125);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return own(e.exitCode === 0 ? 0 : 2);
    if (e instanceof Failure) {
      if (e.message) console.error(e.message);
      return own(e.code);
    }
    throw e;
  }
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
