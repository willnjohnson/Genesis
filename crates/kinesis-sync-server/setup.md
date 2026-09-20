# Setting up a Kinesis sync server

This guide is for whoever runs the sync server: it takes you from nothing to a working server that
Kinesis users can connect to, with Cloudflare in front of it. For how the server works and what it
serves, see the [README](README.md); for the wire format, the
[protocol spec](../../docs/sync-protocol.md).

## Read this first: where the server can and can't run

The server is a **native program that keeps running** and keeps two SQLite files on disk (your
curated Kinesis database, and its own small state file). That decides what fits:

| Platform | Can it host the server? | Notes |
|---|---|---|
| A VPS, a cloud VM, a home server, a Raspberry Pi | **Yes** | The normal choice. Any Linux box with a persistent disk. |
| **Cloudflare Tunnel** (`cloudflared`) | **Yes, as the front door** | Not a host: it securely exposes a server running elsewhere, with HTTPS and no open ports. **Recommended.** |
| Cloudflare Workers / Pages / R2 / D1 | **No** | Different runtime; a Worker can't run this program or open local SQLite files. Running here would mean rewriting the server. |
| **Vercel** | **No** | Vercel runs short-lived serverless functions: no long-running process, no persistent disk for the databases, no background scanner. It can't run this server. |

If you already use Vercel for a website, that's fine: keep it there, and give the sync server its
own subdomain (`sync.example.com`) pointing at wherever the server runs. Kinesis only needs an
HTTPS address; it doesn't care what else lives on the domain.

**The setup this guide builds:** the server on a small VPS or home machine, listening only on
`127.0.0.1`, published to the internet through a Cloudflare Tunnel at `https://sync.example.com`.

```
Kinesis app ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ kinesis-sync-server (127.0.0.1:8787)
                                                                     │ reads (read-only)
                                                                     ▼
                                                              master.db (your curated data)
```

## What you need

- A machine that stays on (1 vCPU / 512 MB RAM is plenty; disk needs to hold your database).
- Your curated Kinesis database (you build it with the Kinesis app).
- A domain whose DNS is on Cloudflare (needed for a permanent tunnel address).
- Optional, for licensing: your own Venice / YouTube Data / Pixabay API keys.
- `sqlite3` and the ability to build Rust (or a prebuilt binary; see step 1).

---

## Step 1: Get the server binary

Build it on the machine that will run it (Rust 1.88 or newer):

```sh
git clone <your Kinesis repo>
cd Kinesis/crates/kinesis-sync-server
cargo build --release
sudo install -d /opt/kinesis-sync /etc/kinesis-sync /var/lib/kinesis-sync
sudo cp target/release/kinesis-sync-server /opt/kinesis-sync/
```

Building on a different OS than you'll run it on needs cross-compilation; simplest is to build on
the server itself. There is no official container image yet.

## Step 2: Create access tokens

Each user (or team) gets a token. It's what lets them sync, and, if you enable it, use your API keys.
Use long random values (the server refuses tokens under 16 characters).

```sh
openssl rand -hex 24          # Linux / macOS
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

Keep a list of who has which token; you'll revoke by removing one.

## Step 3: Write the config

Create `/etc/kinesis-sync/config.toml` (a fuller example with every option is in
[`config.example.toml`](config.example.toml)):

```toml
bind = "127.0.0.1:8787"                 # localhost only; Cloudflare Tunnel reaches it from here
server_name = "Acme Research Library"   # shown to users in the app

master_db = "/var/lib/kinesis-sync/master.db"
state_db  = "/var/lib/kinesis-sync/state.db"

scan_interval_secs = 30

[[tokens]]
name = "alice"
token = "PASTE-ALICE'S-TOKEN"
licenses = ["venice", "youtube"]        # providers Alice may use through your keys; [] = none

[[tokens]]
name = "bob"
token = "PASTE-BOB'S-TOKEN"
licenses = []

[policy]
enforced = ["showSummarizeVenice", "allowDeletionLibrary"]   # see "Enforcing settings" below

[providers.venice]
api_key_env = "VENICE_API_KEY"
[providers.youtube]
api_key_env = "YOUTUBE_API_KEY"
```

Relative paths in the config are relative to the directory the server is started from. Use
absolute paths (as above) or set `WorkingDirectory` in the service.

Put the provider keys in an environment file rather than the config, readable only by the service:

```sh
sudo tee /etc/kinesis-sync/providers.env >/dev/null <<'EOF'
VENICE_API_KEY=...
YOUTUBE_API_KEY=...
EOF
sudo chmod 600 /etc/kinesis-sync/providers.env
```

The config is read **once at startup**; restart the service after editing it.

## Step 4: Publish your content

The server reads a copy of your Kinesis database. You curate in the Kinesis app on your own
computer, then **publish** a copy to the server. (Kinesis shows where your database lives under
**Settings → Database**.)

Don't upload your working database as-is: it also holds your own API keys and search history.
This script makes a clean copy, applies the settings you want to enforce, and swaps it in
atomically (so the server never reads a half-copied file):

```sh
#!/bin/sh
# publish.sh: run on the computer where you curate. Needs sqlite3, ssh and rsync.
set -eu
SRC="$HOME/path/to/kinesis_data.db"     # Settings > Database shows this path
HOST="user@sync-server"
DEST="/var/lib/kinesis-sync"

TMP="$(mktemp)"
sqlite3 "$SRC" ".backup '$TMP'"         # a consistent snapshot, safe even if Kinesis is open

sqlite3 "$TMP" <<'SQL'
-- Nothing private goes to the server.
DELETE FROM Settings WHERE key IN ('api_key','venice_api_key','pixabay_api_key','obsidianExportPath');
DELETE FROM Settings WHERE key LIKE 'sync_%';
DELETE FROM SearchHistory;
-- Settings every user will be held to (each must also be listed in config.toml [policy] enforced).
INSERT OR REPLACE INTO Settings (key, value) VALUES ('showSummarizeVenice', 'false');
INSERT OR REPLACE INTO Settings (key, value) VALUES ('allowDeletionLibrary', 'false');
SQL

rsync "$TMP" "$HOST:$DEST/master.db.new"
ssh "$HOST" "mv $DEST/master.db.new $DEST/master.db"   # atomic replace on the same disk
rm -f "$TMP"
```

Within `scan_interval_secs` the server notices the new file and users' apps pick up exactly what
changed on their next sync. You can publish as often as you like.

**Two rules the server enforces for you:**
- API keys, tokens and folder paths are never served, even if they're in the file.
- If a new copy would remove more than half of the catalogue (for example the wrong file, or an
  empty one), the server **refuses the scan** and keeps serving the last good state. If you truly
  meant it, set `allow_mass_removal = true`, publish, then turn it back off.

### Enforcing settings

`[policy] enforced` in `config.toml` lists the settings every user must follow; the **values** come
from the `Settings` table of the database you publish (the `INSERT` lines above). Users see those
controls greyed out. Values are `'true'` / `'false'` for on/off flags.

Common ones: `showSummarizeVenice`, `showSummarizeOllama`, `showSynthesizeVenice`,
`showSynthesizePixabay`, `showSynthesizeUpload`, `plugin_summarize_enabled`,
`plugin_photosynthesis_enabled`, `allowDeletionLibrary`, `allowModificationGlossary`,
`showBiography`, `showDrive`, `allowEditBio`, `allowEditWDBS`, `showSearch`, `theme`.
Beyond these there are flags for every tab, view and action (`showTabTheme`, `showTabSync`,
`allowSaveToLibrary`, `defaultView`, and so on). [docs/customizing.md](../../docs/customizing.md)
lists each one with its default and effect. The complete list of what a server may enforce is
`SYNCABLE_SETTINGS` and `FEATURE_FLAGS` in `crates/kinesis-sync-proto/src/settings.rs`; the server
refuses to start if `enforced` contains anything not on it.

## Step 5: Run it as a service

`/etc/systemd/system/kinesis-sync.service`:

```ini
[Unit]
Description=Kinesis sync server
After=network.target

[Service]
ExecStart=/opt/kinesis-sync/kinesis-sync-server --config /etc/kinesis-sync/config.toml
EnvironmentFile=/etc/kinesis-sync/providers.env
User=kinesis-sync
Restart=on-failure
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /var/lib/kinesis-sync kinesis-sync
sudo chown -R kinesis-sync /var/lib/kinesis-sync
sudo systemctl daemon-reload
sudo systemctl enable --now kinesis-sync
curl http://127.0.0.1:8787/healthz          # prints: ok
journalctl -u kinesis-sync -f               # the log
```

A healthy start logs `initial scan: N changed, 0 removed, revision N` and
`listening on http://127.0.0.1:8787`. If the master database can't be read, the server exits with
a clear message instead of serving nothing.

Check it with a token:

```sh
curl -H "Authorization: Bearer PASTE-ALICE'S-TOKEN" http://127.0.0.1:8787/api/v1/manifest
```

You should see your `server_name` and, for Alice, `"license":["venice","youtube"]`.

## Step 6: Put Cloudflare in front

The server speaks plain HTTP on localhost. **Cloudflare Tunnel** publishes it as
`https://sync.example.com` without opening any port on your machine.

### Try it in two minutes (no account needed)

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a temporary `https://<random>.trycloudflare.com` address that works immediately, good
for testing from the Kinesis app. It changes on every run and isn't for production.

### Permanent tunnel on your domain

Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
on the same machine, then:

```sh
cloudflared tunnel login                                   # pick the domain in the browser
cloudflared tunnel create kinesis-sync                     # prints a tunnel ID (UUID)
cloudflared tunnel route dns kinesis-sync sync.example.com # creates the DNS record for you
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json      # copy it here from ~/.cloudflared/
ingress:
  - hostname: sync.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```sh
sudo cloudflared service install
sudo systemctl enable --now cloudflared
curl https://sync.example.com/healthz                      # prints: ok
```

(You can also create the tunnel from the Cloudflare dashboard's Zero Trust section and install it
with the token it gives you; the menu names change, so the command-line route above is the stable one.)

### Cloudflare settings that matter

- **Don't put Cloudflare Access (login walls) in front of `/api/`.** The Kinesis app authenticates
  with the bearer token only and can't complete an interactive login. The server's own tokens are
  the access control.
- **Bot Fight Mode / strict WAF rules** can block the app, which is a program rather than a
  browser. If users see HTTP 403 with an HTML page, add a WAF **Skip** rule for the hostname
  `sync.example.com` (or the path `/api/`).
- **Caching:** API responses aren't cached by default; if you use broad Cache Rules, exclude
  `sync.example.com`.
- **Timeouts:** Cloudflare gives up on a request that takes around 100 seconds (a `524` error;
  check your plan's current limit). Almost everything here is far faster, but a very long AI
  summary through the license proxy could hit it. If that happens, users will see the summary
  fail, and you can enable a longer limit on plans that allow it, or have those users use their own key.
- **HTTPS:** the Kinesis app requires `https` for anything except localhost and private-network
  addresses. The tunnel provides it.

## Step 7: Connect Kinesis

In the Kinesis app: **Settings → Sync**, enter `sync.example.com` (or the full `https://` address)
and the user's token, then **Test connection** and **Connect & sync**. The first sync downloads
the whole catalogue (roughly the size of your database), so it can take a while with many
transcripts; later syncs only transfer changes.

Give each user their token privately. Don't reuse one token across people if you want to revoke
or meter them individually.

---

## Day-to-day operations

| Task | How |
|---|---|
| Publish new content | Run your `publish.sh`. Users pick it up on their next sync (auto-sync runs at app start and on their chosen interval). |
| Add or revoke a user | Edit `[[tokens]]` in `config.toml`, `systemctl restart kinesis-sync`. A removed token is refused immediately after the restart. |
| Change enforced settings | Edit the values in your publish script and re-publish; to change *which* settings are enforced, edit `[policy] enforced` and restart. |
| Rotate a provider key | Update `providers.env`, restart. Users notice nothing. |
| Update the server | Rebuild, replace the binary, restart. Users' apps keep working. |
| See who's using your keys | `journalctl -u kinesis-sync` shows each proxied call with the token's *name*, provider and status. Set `proxy_rate_limit_per_minute` to cap a runaway client. |
| Reset everything | Delete `state.db` and restart. It's disposable: clients detect the new history and re-download once. |
| Back up | Your curated database on your own computer is the source of truth. The server holds only a copy plus disposable state. |
| Monitor | Poll `https://sync.example.com/healthz` (no token needed). |

## Licensing your API keys: what to know

- A licensed user's Venice, YouTube and Pixabay calls run through your server with **your** keys,
  and count against **your** quotas and bills. Only license people you trust, and prefer per-person
  tokens so you can see and cut off usage.
- Keys never reach users' computers. They can't extract them from the app, the exports or the sync
  data.
- `license_mode = "fallback"` (default): a user's own key wins, and your license fills in when
  they have none. `"enforce"`: everyone uses your license and their own keys are bypassed (useful
  when you want all usage visible on your side).
- A provider only appears as licensed if the token lists it **and** the server actually has that
  provider's key configured.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| App says "The server rejected the access token." | Wrong or removed token. Check `config.toml` and restart after edits. |
| App says "Couldn't reach the server" | Tunnel or service down. `systemctl status kinesis-sync cloudflared`, then `curl https://sync.example.com/healthz`. |
| HTTP 403 with an HTML page | Cloudflare bot protection or a WAF rule; see the Cloudflare settings above. |
| HTTP 524 / long summaries fail through the license | Cloudflare's ~100 second limit on a request. |
| Server won't start: "can't open master database" | `master_db` path wrong or unreadable by the service user. Use absolute paths; check ownership. |
| Server won't start: "policy.enforced contains settings that can't be managed remotely" | A key in `enforced` isn't on the allowlist (for example an API key, which can never be enforced). |
| Log: "scan failed: refusing to remove N of M items" | The published file is missing most of the catalogue (wrong or empty file). Fix it, or set `allow_mass_removal = true` for an intentional cleanup. The last good data keeps being served meanwhile. |
| Users don't see your latest content | Wait one `scan_interval_secs`, check the log for `scan: N changed`, then have the user press **Sync now**. |
| A user edited a synced item and wants yours back | **Full resync** in their Sync tab restores every item you provide. |

## Security checklist

- [ ] Server listens on `127.0.0.1` only; the tunnel is the only way in.
- [ ] Tokens are long and random, one per person or team.
- [ ] `providers.env` is `chmod 600` and owned by the service user.
- [ ] Your publish script strips `api_key`, `venice_api_key`, `pixabay_api_key`, `sync_*` and
      `SearchHistory` from the copy it uploads.
- [ ] No Cloudflare Access login in front of `/api/`, and a WAF skip rule if bot protection blocks the app.
- [ ] You know who holds each token and can revoke it.
