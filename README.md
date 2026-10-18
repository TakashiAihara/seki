# seki

Shared / exclusive leases with a TTL, for resources that several agents or hosts contend for: a remote GPU notebook, a port a server listens on, anything you can name with a string.

- A lease is taken either shared (any number of holders at once) or exclusive (only when nobody else holds the resource).
- Every lease expires. The holder renews it while it works; a holder that crashes stops renewing and the lease falls away.
- Taking a lease is one atomic step on the server. Two callers can never both win an exclusive lease.
- seki does not know what a resource is. `paperspace:abc123` and `paperspace:abc123:6006` are just names.

The server is [PocketBase](https://pocketbase.io) with the hooks and migration in this repository. The CLI is a single binary.

## CLI

```text
seki acquire <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>]
seki renew   <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>]
seki release <resource>
seki ls [--json]
seki run <resource> (--shared | --exclusive) [--ttl <duration>] [--why <text>] -- <command> [args...]
```

- `--shared` or `--exclusive` is required. There is no default mode.
- `--ttl` takes `90s`, `30m`, `6h` or a number of seconds. The default is `1h`.
- `renew` is `acquire` again by the same holder: it moves the expiry of the caller's own lease.
- `release` drops only the caller's own lease. Releasing something you do not hold prints `not held <resource>` and exits 0.
- `run` takes the lease, runs the command, renews the lease in the background every third of the TTL, and releases it when the command ends, however it ends. If the lease cannot be taken the command is not started.
- Every command takes `--holder <id>`. Without it the holder is `$SEKI_HOLDER`, then `$USER@<hostname>`. The host is always recorded as the machine's hostname.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | done (`run`: the command's own exit code) |
| 1 | the resource is held by someone else; stderr lists who, in which mode, from which host, why, and until when |
| 2 | usage error, missing configuration, server unreachable, wrong token, or any other server error |

`run` exits with the command's exit code, or 128 + the signal number when the command is killed by a signal.

A server that cannot be reached is exit 2, never 0: when seki cannot tell whether the resource is free, the caller should not touch it.

### Configuration

| setting | environment | `~/.config/seki/config.json` |
| --- | --- | --- |
| server URL | `SEKI_URL` | `url` |
| bearer token | `SEKI_TOKEN` | `token`, or `token_command` (run with `sh -c`, stdout trimmed) |
| holder | `SEKI_HOLDER` | `holder` |

The environment wins over the file. `$XDG_CONFIG_HOME` replaces `~/.config` when set.

## Server

- Fetch PocketBase with `scripts/fetch-pocketbase.sh` (the version is pinned in `.pocketbase-version`), then run it with this repository's hooks and migrations:

```bash
SEKI_TOKEN=<shared token> bin/pocketbase serve --dir /var/lib/seki --hooksDir pb_hooks --migrationsDir pb_migrations --http 0.0.0.0:8090
```

- A server started without `SEKI_TOKEN` refuses every request.
- The PocketBase admin UI (`/_/`) shows the `leases` collection and is the dashboard. Create the first superuser with `bin/pocketbase superuser upsert <email> <password> --dir /var/lib/seki`.
- The lease records are not readable through PocketBase's own record API; only the routes below serve them.

### HTTP API

All routes need `Authorization: Bearer <SEKI_TOKEN>`.

| route | body | answer |
| --- | --- | --- |
| `POST /api/seki/acquire` | `{resource, holder, mode, ttl_sec, host?, why?}` | 200 `{ok, lease}` / 409 `{ok: false, held_by: [lease...]}` / 400 |
| `POST /api/seki/release` | `{resource, holder}` | 200 `{ok, released: <rows>}` |
| `GET /api/seki/leases` | | 200 `{ok, leases: [lease...]}` (expired leases are left out) |

A lease is `{resource, holder, mode, host, why, expires_at}`, `expires_at` in Unix milliseconds.

## Development

```bash
bun install
bun test        # fetches PocketBase first, then runs the server and CLI tests against it
bun run typecheck
```
