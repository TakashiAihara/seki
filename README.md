# seki

Shared / exclusive leases with a TTL, for resources that several agents or hosts contend for: a remote GPU notebook, a port a server listens on, anything you can name with a string.

- A lease is taken either shared (any number of holders at once) or exclusive (only when nobody else holds the resource).
- Every lease expires. The holder renews it while it works; a holder that crashes stops renewing and the lease falls away.
- Taking a lease is one atomic step on the server. Two callers can never both win an exclusive lease.
- seki does not know what a resource is. `paperspace:abc123` and `paperspace:abc123:6006` are just names.

The server is [PocketBase](https://pocketbase.io) with the hooks and migration in this repository. The CLI is a single binary.

## CLI

```text
seki acquire <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>] [--holder <id>]
seki release <resource> [--holder <id>]
seki ls [--json]
seki run <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>] [--holder <id>] -- <command> [args...]
```

- `--shared` or `--exclusive` is required. There is no default mode.
- `--ttl` takes `90s`, `30m`, `6h` or a number of seconds, from 3 seconds up to 7 days (`168h`). The default is `10m`: a holder that crashes without releasing blocks others until then.
- To renew, `acquire` again with the same holder. It replaces the caller's own lease (mode, ttl and reason), so it can also move a shared lease to exclusive when nobody else holds the resource.
- `release` drops only the caller's own lease. Releasing something you do not hold prints `not held <resource>` and exits 0.
- `run` takes the lease, runs the command, renews the lease in the background every third of the TTL, and releases it when the command ends, however it ends. If the lease cannot be taken the command is not started.
- If `run` loses the lease while the command runs — another holder took it after it lapsed, or renews kept failing until it lapsed — it stops the command with SIGTERM. Whoever holds the lease now was told the resource is theirs.
- SIGTERM and SIGHUP sent to `run` are passed to the command. SIGINT is not: Ctrl-C in a terminal already reaches the command, and `run` waits for the command to exit before releasing.
- The holder is `--holder <id>`, else `$SEKI_HOLDER`. `acquire`, `renew` and `release` refuse to run without one (exit 2): there is no safe default, because every session of the same user on one host would get the same name, and a second exclusive acquire under the same name renews the first one's lease instead of being refused. Give each session its own holder (for an AI agent, its session id).
- `run` without a holder makes one for that invocation (`$USER@<hostname>#<random>`), since it takes and releases its own lease.
- The host is always recorded as the machine's hostname.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | done (`run`: the command's own exit code) |
| 1 | the resource is held by someone else; stderr lists who, in which mode, from which host, why, and until when |
| 2 | usage error, missing configuration, server unreachable, wrong token, or any other server error |

`run` passes the command's exit code through (128 + the signal number when the command is killed by a signal), so its own outcomes use codes of their own:

| code | meaning for `run` |
| --- | --- |
| 124 | the lease could not be taken, or was lost while the command ran (as `timeout` uses 124) |
| 125 | seki itself failed: usage, configuration, server (as `env` uses 125) |

A server that cannot be reached is exit 2, never 0: when seki cannot tell whether the resource is free, the caller should not touch it.

### Configuration

| setting | environment | `~/.config/seki/config.json` |
| --- | --- | --- |
| server URL | `SEKI_URL` | `url` |
| bearer token | `SEKI_TOKEN` | `token`, then `token_command` (run with `sh -c`, stdout trimmed) |
| holder | `SEKI_HOLDER` | (not read from the file: one file is shared by every session on the host) |
| request timeout | `SEKI_TIMEOUT_MS` (default 10000) | |

The environment wins over the file. `$XDG_CONFIG_HOME` replaces `~/.config` when set.

## Server

- Fetch PocketBase with `scripts/fetch-pocketbase.sh` (the version is pinned in `.pocketbase-version`), then run it with this repository's hooks and migrations:

```bash
SEKI_TOKEN=<shared token> bin/pocketbase serve --dir /var/lib/seki --hooksDir pb_hooks --migrationsDir pb_migrations --http 0.0.0.0:8090
```

- A server started without `SEKI_TOKEN` refuses every request.
- Trust model: anyone with the token can take, extend and release any lease. The holder is a name the client sends, not an identity the server checks; it keeps honest callers apart, not hostile ones.
- The server speaks plain HTTP. Put it behind TLS if the token should not cross the network in the clear.
- The server applies the migrations in `pb_migrations/` on start, so updating the checkout and restarting can change the schema.
- The PocketBase admin UI (`/_/`) shows the `leases` collection and is the dashboard. Create the first superuser with `bin/pocketbase superuser upsert <email> <password> --dir /var/lib/seki`.
- The lease records are not readable through PocketBase's own record API; only the routes below serve them.

### HTTP API

All routes need `Authorization: Bearer <SEKI_TOKEN>`.

| route | body | answer |
| --- | --- | --- |
| `POST /api/seki/acquire` | `{resource, holder, mode, ttl_sec (1 to 604800), host?, why?}` | 200 `{ok, lease}` / 409 `{ok: false, held_by: [lease...]}` / 400 |
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
