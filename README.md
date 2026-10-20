# seki

Shared / exclusive leases with a TTL, for resources that several agents or hosts contend for: a remote GPU notebook, a port a server listens on, anything you can name with a string.

- A lease is taken either shared (any number of holders at once) or exclusive (only when nobody else holds the resource).
- Every lease expires. The holder renews it while it works; a holder that crashes stops renewing and the lease falls away.
- Taking a lease is one atomic step on the server. Two callers can never both win an exclusive lease.
- seki does not know what a resource is. `paperspace:abc123` and `paperspace:abc123:6006` are just names.

The server is [PocketBase](https://pocketbase.io) with the hooks and migration in this repository. The CLI is a single binary.

## CLI

```text
seki acquire <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>] [--wait <duration>] (--holder <id> | $SEKI_HOLDER)
seki release <resource> (--holder <id> | $SEKI_HOLDER)
seki ls [--json]
seki run <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>] [--wait <duration>] [--holder <id>] -- <command> [args...]
```

- `--shared` or `--exclusive` is required. There is no default mode.
- `--ttl` takes `90s`, `30m`, `6h` or a number of seconds, from 3 seconds up to 7 days (`168h`). The default is `10m`: a holder that crashes without releasing blocks others until then.
- To renew, `acquire` again with the same holder. It replaces the caller's own lease (mode, ttl and reason), so it can also move a shared lease to exclusive when nobody else holds the resource.
- `--wait <duration>` (same format, up to 7 days) waits for a held resource instead of giving up at once. The caller joins the resource's queue, asks again every second, prints its place in the queue to stderr when it changes, and takes the lease when its turn comes. Past the duration it leaves the queue and exits as if it had not waited (1, or 124 for `run`).
- The queue is first come, first served. A request waits behind every waiter that came before it and would conflict with it (either side exclusive), so a shared request does not pass an exclusive one that is waiting, even while only shared holders hold the resource. Shared waiters with no exclusive one ahead go in together. A request without `--wait` comes after everyone waiting. A holder renewing its own lease is never held up by the queue.
- A waiter that stops asking (killed, or a Ctrl-C while waiting) drops out of the queue about 30 seconds later (`SEKI_TIMEOUT_MS` + 21 s).
- `ls` prints the live leases, then (when anyone waits) the queue: resource, place, mode, holder, host, how long it has waited, why. `ls --json` prints `{"leases": [...], "waiting": [...]}`.
- `release` drops only the caller's own lease. Releasing something you do not hold prints `not held <resource>` and exits 0.
- `run` takes the lease, runs the command, renews the lease in the background every third of the TTL, and releases it when the command ends, however it ends. If the lease cannot be taken the command is not started.
- `run` stops the command when it loses the lease while the command runs: the lease lapsed before a renew got through (each renew is cut off at the lease's expiry, so a hung server cannot stretch it), the server no longer had the lease when a renew arrived, or another holder holds it now. Whoever holds the lease now was told the resource is theirs. The command's whole process group gets SIGTERM, and SIGKILL `SEKI_KILL_AFTER_MS` later (default 10000) if any of it is still running. Until then the command can overlap the next holder by up to that long.
- Renews are sent with `renew: true`, so a renew the server receives after the lease ran out is refused (410) instead of creating a new lease.
- The command runs in its own session and process group. When the command exits, whatever is left of its group (background processes) gets SIGTERM, then SIGKILL after `SEKI_KILL_AFTER_MS`, and only then is the lease released. If part of the group is still there after SIGKILL (a process stuck in the kernel), `run` warns and leaves the lease to expire instead of releasing it. A process that leaves the group on its own (`setsid`) is out of reach.
- SIGINT, SIGTERM, SIGHUP and SIGQUIT sent to `run` (Ctrl-C and Ctrl-\ included) are passed to that group.
- Because of that, the command has no controlling terminal. Piped stdin and stdout work as usual; what does not work is opening `/dev/tty` (password prompts of sudo, ssh or gpg) and job control: Ctrl-Z stops `run` but not the command, the renewals stop with it, the lease lapses, and on resume `run` stops the command (123). `run` is for batch commands.
- `run` cannot stop the command if `run` itself is killed with SIGKILL: the lease then expires on its own while the command keeps running.
- If the first answer from the server arrives with less than a third of the lease left, `run` releases it and does not start the command (125).
- Every acquire carries `not_after`, the time this client stops waiting for the answer. The server refuses a request it processes later than that (408), so a request that times out on the client never leaves a lease behind. Hosts need roughly synchronized clocks (NTP): a client clock behind the server's by more than `SEKI_TIMEOUT_MS` makes every request fail.
- The holder is `--holder <id>`, else `$SEKI_HOLDER`. `acquire` and `release` refuse to run without one (exit 2): there is no safe default, because every session of the same user on one host would get the same name, and a second exclusive acquire under the same name renews the first one's lease instead of being refused. Give each session its own holder (for an AI agent, its session id).
- `run` always adds a random suffix to the holder (`<--holder, $SEKI_HOLDER or $USER@<hostname>>#<random>`), since it takes and releases its own lease: two runs of one session must not share a lease.
- The host is always recorded as the machine's hostname.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | done (`run`: the command's own exit code) |
| 1 | the resource is held by someone else, or others are waiting for it first; stderr lists who holds it (mode, host, reason, until when) and who waits ahead |
| 2 | usage error, missing configuration, server unreachable, wrong token, or any other server error |

`run` passes the command's exit code through (128 + the signal number when the command is killed by a signal), so its own outcomes use codes of their own:

| code | meaning for `run` |
| --- | --- |
| 123 | the lease was lost while the command ran, and the command was stopped |
| 124 | the lease could not be taken; the command did not start (as `timeout` uses 124) |
| 125 | seki itself failed before the command started: usage, configuration, server (as `env` uses 125) |
| 126 | the command is not executable (as `env`) |
| 127 | the command was not found (as `env`) |

A server that cannot be reached is exit 2, never 0: when seki cannot tell whether the resource is free, the caller should not touch it.

### Configuration

| setting | environment | `~/.config/seki/config.json` |
| --- | --- | --- |
| server URL | `SEKI_URL` | `url` |
| bearer token | `SEKI_TOKEN` | `token`, then `token_command` (run with `sh -c`, stdout trimmed) |
| holder | `SEKI_HOLDER` | (not read from the file: one file is shared by every session on the host) |
| request timeout | `SEKI_TIMEOUT_MS` (default 10000, at least 1) | |
| `run`: SIGKILL after SIGTERM | `SEKI_KILL_AFTER_MS` (default 10000, 0 = SIGKILL at once) | |

The environment wins over the file. `$XDG_CONFIG_HOME` replaces `~/.config` when set.

## Server

- Fetch PocketBase with `scripts/fetch-pocketbase.sh` (the version is pinned in `.pocketbase-version`, the archives' sha256 in `.pocketbase-sha256`), then run it with this repository's hooks and migrations:

```bash
SEKI_TOKEN=<shared token> bin/pocketbase serve --dir /var/lib/seki --hooksDir pb_hooks --migrationsDir pb_migrations --http 0.0.0.0:8090
```

- A server started without `SEKI_TOKEN` refuses every request.
- Trust model: anyone with the token can take, extend and release any lease. The holder is a name the client sends, not an identity the server checks; it keeps honest callers apart, not hostile ones.
- The server speaks plain HTTP. Put it behind TLS if the token should not cross the network in the clear.
- The server applies the migrations in `pb_migrations/` on start, so updating the checkout and restarting can change the schema.
- The PocketBase admin UI (`/_/`) shows the `leases` collection and is the dashboard. Superuser login alerts ("login from a new location" mail) are turned off by a migration, and `deploy/seki.service` hides `sendmail` from the server, so the mail that password reset and the other mail routes would send fails at once. The HTTP routes still answer as usual (password reset returns 204); only the delivery fails, and no mail leaves the host. The server is not set up to send mail; before this, each attempt left a `sendmail` process retrying. Create the first superuser as the service's user, so the data files stay owned by it: `runuser -u seki -- bin/pocketbase superuser upsert <email> <password> --dir /var/lib/seki`.
- `deploy/seki.service` runs the server as the system user `seki` with the data in `/var/lib/seki`; `deploy/update.sh` brings `/opt/seki` to `origin/main` and restarts it.
- The lease records are not readable through PocketBase's own record API; only the routes below serve them.

### HTTP API

All routes need `Authorization: Bearer <SEKI_TOKEN>`.

| route | body | answer |
| --- | --- | --- |
| `POST /api/seki/acquire` | `{resource, holder, mode, ttl_sec (integer, 1 to 604800), host?, why?, renew?, not_after? (Unix ms)}`; strings up to 500 characters | 200 `{ok, renewed, lease}` (`renewed` is true when the holder's live lease was extended, false when a new one was created) / 409 `{ok: false, held_by: [lease...]}` / 410 when `renew: true` and the holder has no live lease (nothing is created) / 408 when processed after `not_after` (nothing is created) / 400 |
| `POST /api/seki/release` | `{resource, holder}` | 200 `{ok, released: <rows>}` |
| `GET /api/seki/leases` | | 200 `{ok, leases: [lease...]}` (expired leases are left out) |

A lease is `{resource, holder, mode, host, why, expires_at}`, `expires_at` in Unix milliseconds.

## Development

```bash
bun install
sh scripts/fetch-pocketbase.sh   # the tests run against the real PocketBase in bin/
bun test
bun run typecheck
```
