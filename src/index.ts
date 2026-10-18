import { readFile } from "node:fs/promises";
import { constants, homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

declare const SEKI_VERSION: string;

const version = typeof SEKI_VERSION === "undefined" ? "dev" : SEKI_VERSION;

type Mode = "shared" | "exclusive";

type Lease = { resource: string; holder: string; mode: Mode; host: string; why: string; expires_at: number };

type FileConfig = { url?: string; token?: string; token_command?: string; holder?: string };

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

function resolveHolder(flag: string | undefined, file: FileConfig): string {
  const holder = flag || process.env.SEKI_HOLDER || file.holder;
  if (holder) return holder;
  // Without USER there is no identity to fall back to, so refuse instead of inventing one.
  const user = process.env.USER;
  if (!user) throw new Failure(2, "cannot pick a holder: set --holder, SEKI_HOLDER or USER");
  return `${user}@${hostname()}`;
}

function modeOf(o: LeaseOpts): Mode {
  if (o.shared) return "shared";
  if (o.exclusive) return "exclusive";
  throw new Failure(2, "one of --shared or --exclusive is required");
}

function parseTtl(value: string): number {
  const m = /^([1-9]\d*)([smh]?)$/.exec(value);
  if (!m) throw new InvalidArgumentError(`takes 90s, 30m, 6h or a number of seconds, got "${value}"`);
  const unit = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  return Number(m[1]) * unit;
}

async function call(cfg: Config, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(cfg.url.replace(/\/+$/, "") + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Failure(2, `server unreachable at ${cfg.url}: ${errText(e)}`);
  }
  return { status: res.status, text: await res.text() };
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
  const file = await loadFileConfig();
  const holder = resolveHolder(o.holder, file);
  const cfg = await connect(file);
  const r = await acquire(cfg, { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why });
  if ("heldBy" in r) throw new Failure(1, heldMessage(resource, r.heldBy));
  console.log(`acquired ${resource} ${mode} until ${new Date(r.lease.expires_at).toISOString()}`);
  return 0;
}

async function releaseCmd(resource: string, o: { holder?: string }): Promise<number> {
  const file = await loadFileConfig();
  const holder = resolveHolder(o.holder, file);
  const cfg = await connect(file);
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
  const file = await loadFileConfig();
  const holder = resolveHolder(o.holder, file);
  const cfg = await connect(file);
  const body: AcquireBody = { resource, holder, mode, ttl_sec: o.ttl, host: hostname(), why: o.why };

  const first = await acquire(cfg, body);
  if ("heldBy" in first) throw new Failure(1, heldMessage(resource, first.heldBy));

  // A third of the ttl: one renew can fail and the next still lands before expiry.
  const renew = setInterval(async () => {
    try {
      const r = await acquire(cfg, body);
      if ("heldBy" in r) console.error(`warning: ${resource} was taken over by ${r.heldBy[0]?.holder}`);
    } catch (e) {
      console.error(`warning: renew ${resource} failed: ${errText(e)}`);
    }
  }, Math.max(1000, (o.ttl * 1000) / 3));

  let child: Subprocess;
  try {
    child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    clearInterval(renew);
    await dropLease(cfg, resource, holder);
    throw new Failure(2, `cannot start ${command[0]}: ${errText(e)}`);
  }

  // Forwarded so the child's own handlers see the signal; the lease is dropped only after it exits.
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    await child.exited;
  } finally {
    clearInterval(renew);
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    await dropLease(cfg, resource, holder);
  }

  const code = child.exitCode;
  if (code !== null) return code;
  const sig = child.signalCode;
  if (typeof sig !== "string") throw new Failure(2, "child exited without a code or a signal");
  return 128 + constants.signals[sig];
}

function addHolder(c: Command): Command {
  return c.option("--holder <name>", "holder name; default $SEKI_HOLDER, then the config file, then $USER@host");
}

function addLeaseOptions(c: Command): Command {
  return addHolder(c)
    .addOption(new Option("--shared", "several shared holders may coexist").conflicts("exclusive"))
    .addOption(new Option("--exclusive", "no other holder while this one is held").conflicts("shared"))
    .addOption(
      new Option("--ttl <duration>", "90s, 30m, 6h or a number of seconds").argParser(parseTtl).default(3600, "1h"),
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
  addLeaseOptions(program.command("acquire").description("take a lease").argument("<resource>")).action(lease);
  addLeaseOptions(program.command("renew").description("extend a lease you hold").argument("<resource>")).action(lease);

  addHolder(program.command("release").description("drop a lease you hold").argument("<resource>")).action(
    async (resource: string, o: { holder?: string }) => {
      code = await releaseCmd(resource, o);
    },
  );

  addHolder(program.command("ls").description("list live leases"))
    .option("--json", "print the leases as JSON")
    .action(async (o: { json?: boolean }) => {
      code = await lsCmd(o);
    });

  addLeaseOptions(
    program.command("run").description("hold a lease while a command runs").argument("<resource>").argument("<command...>"),
  ).action(async (resource: string, command: string[], o: LeaseOpts) => {
    // Commander drops the -- separator, so it is checked against argv to refuse a command given without it.
    if (!argv.includes("--")) throw new Failure(2, "put -- before the command: seki run <resource> --shared -- <command>");
    code = await runCmd(resource, command, o);
  });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    if (e instanceof Failure) {
      if (e.message) console.error(e.message);
      return e.code;
    }
    throw e;
  }
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
