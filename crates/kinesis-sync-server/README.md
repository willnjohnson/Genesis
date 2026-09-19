# kinesis-sync-server

A reference sync server for Kinesis. Point it at a Kinesis database you curate, and every Kinesis
app connected to it receives that content, follows the settings you enforce, and (optionally) uses
your AI and API keys without ever seeing them.

Protocol: [`docs/sync-protocol.md`](../../docs/sync-protocol.md).
Deploying it (Cloudflare Tunnel, systemd, publishing content): **[`setup.md`](setup.md)**.

## How it works

- **Content.** The server reads your *master* database (a normal Kinesis DB) read-only: categories
  with their aliases and icons, videos with transcripts and summaries, glossary, bios and custom
  prompts. You never change its schema; curate it with the Kinesis app. Every few seconds the
  server hashes each row, and rows whose hash changed get a new revision. Rows that disappeared
  become tombstones. Clients pull the changes since their last revision.
- **Policy.** Settings you list under `[policy] enforced` are pushed to clients and locked
  there. Their values come from the master database's `settings` table.
- **License.** Users' provider calls (Venice, YouTube Data API, Pixabay) go through
  `/api/v1/proxy/...` with their token; the server adds the real key. Keys never reach a client.
- **Pull only.** Clients never upload. A client only ever changes rows this server provided, so
  users keep their own videos and notes.

## Run it

```sh
cargo build --release
cp config.example.toml config.toml   # edit master_db and tokens
export VENICE_API_KEY=...            # only for the providers you license
./target/release/kinesis-sync-server --config config.toml
```

Then, in Kinesis: **Settings → Sync**, enter the server address and a token.

`GET /healthz` answers without a token, for load balancers.

### Put TLS in front

The server speaks plain HTTP. Terminate TLS with a reverse proxy (Caddy, nginx, a cloud load
balancer). The Kinesis app requires `https` for anything except `localhost` and private-network
addresses, and sends the access token on every request.

```
sync.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### systemd

```ini
[Unit]
Description=Kinesis sync server
After=network.target

[Service]
ExecStart=/opt/kinesis-sync/kinesis-sync-server --config /etc/kinesis-sync/config.toml
EnvironmentFile=/etc/kinesis-sync/providers.env   # VENICE_API_KEY=..., YOUTUBE_API_KEY=...
User=kinesis-sync
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Operating notes

- **Editing the master while the server runs is fine.** The next scan picks it up. If the master is
  briefly locked by the Kinesis app, the scan waits; a failed scan keeps serving the last good state.
- **Wrong master path.** A scan that would remove more than half of a catalogue is refused. See
  `allow_mass_removal` in the example config.
- **Resetting.** Deleting `state_db` is safe: the server starts a new revision history (a new
  `epoch`), and every client notices and does one full resync.
- **Tokens.** One per user or team. A token unlocks content, policy and only the providers listed
  in its `licenses`. Remove a token from the config and restart to revoke it.
- **Usage.** Each proxied call is logged (`RUST_LOG=info`) with the token *name*, provider and
  status. Set `proxy_rate_limit_per_minute` to cap a runaway client.
- **What users can't get.** API keys and access tokens are never in content, policy or exports.
  Only settings on the shared allowlist can be enforced.

## Development

```sh
cargo test        # unit tests plus end-to-end tests over real HTTP
```

The Kinesis app's own test suite also runs its sync client against this server
(`src-tauri/src/sync/e2e_tests.rs`), using a master database built by Kinesis's own schema code.
