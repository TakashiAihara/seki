import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

export type Server = { url: string; token: string; stop: () => Promise<void> };

// Starts the real PocketBase with this repo's hooks and migrations on a free
// port and a throwaway data dir. Bound to 127.0.0.1: a test server is never
// meant to be reached from the LAN.
export async function startServer(opts: { token?: string | null } = {}): Promise<Server> {
  const binary = join(root, "bin", "pocketbase");
  if (!existsSync(binary)) throw new Error("bin/pocketbase is missing: run `sh scripts/fetch-pocketbase.sh` first");
  const token = opts.token === undefined ? "test-token-" + crypto.randomUUID() : opts.token;
  const dir = mkdtempSync(join(tmpdir(), "seki-test-"));
  const port = await freePort();
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.SEKI_TOKEN;
  if (token !== null) env.SEKI_TOKEN = token;

  const proc = Bun.spawn(
    [binary, "serve", "--dir", join(dir, "pb_data"), "--hooksDir", join(root, "pb_hooks"), "--hooksWatch=false", "--migrationsDir", join(root, "pb_migrations"), "--http", `127.0.0.1:${port}`],
    { env, stdout: "ignore", stderr: Bun.file(join(dir, "pocketbase.log")) },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
    if (i === 99) {
      proc.kill();
      throw new Error(`pocketbase did not come up:\n${await Bun.file(join(dir, "pocketbase.log")).text()}`);
    }
  }

  return {
    url,
    token: token ?? "",
    stop: async () => {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}
