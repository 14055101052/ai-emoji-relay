# AI Emoji secure relay

Minimal Node.js 24 HTTPS service. No third-party runtime dependencies, no alternative image engine. The server calls only:

`https://project--a55e5977-6867-4325-9a5e-5e9efbb3a82c.lovable.app/api/public/emoji/generate`

The permanent Lovable key is read from the server environment; it is never returned to Android or written to logs. Anonymous session tokens are 256-bit random values, expire after one hour, and are verified using SHA-256 hashes in server-only SQLite. Android automatically obtains and refreshes tokens and encrypts them with Android Keystore.

## Public routes

| Method | Route | Authentication | Behavior |
| --- | --- | --- | --- |
| GET | `/healthz` | None | 200 `{"ready":true}` when configured; 503 `{"ready":false}` without server key. Checks local readiness, not live Lovable credential validity. |
| POST | `/api/auth/session` | None | Request `{}`. Response `{"token":"<short-lived opaque token>","expiresInSeconds":3600}`. |
| POST | `/api/emoji/generate` | `Authorization: Bearer <short-lived-token>` | Strict prompt/style request; forwards safe six-field generation response. |

All public routes require HTTPS. No CORS access is enabled, since the client is native Android. Request and response JSON are `Cache-Control: no-store`.

Generation request:

```json
{"prompt":"BMW M4 in Marina Bay Blue","style":"Soft 3D"}
```

Response:

```json
{"success":true,"id":"...","name":"...","imageUrl":"https://...","mimeType":"image/png","expiresInSeconds":604800}
```

The relay forwards only these response fields. The Android app immediately downloads the signed HTTPS PNG without either Authorization header and saves the bytes in existing internal storage/Room. The signed URL is not saved as permanent metadata.

## Required server environment

| Variable | Requirement / default |
| --- | --- |
| `EMOJI_API_KEY` | **Required server-only secret** from the existing Lovable backend. Provision through the hosting provider's secret manager or a root-protected environment file. Never add its value to source, chat, APK, Android Settings or Gradle properties. |
| `RELAY_DB_PATH` | Persistent writable SQLite file; default `./data/relay.sqlite`. Production service uses `/var/lib/ai-emoji-relay/relay.sqlite`. |
| `TLS_TERMINATION` | Set `reverse-proxy` for the supplied Caddy deployment. Otherwise provide both direct TLS certificate variables below. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | Required only for direct HTTPS: paths to your server's valid certificate chain and private key. Never bundle the key with source/APK. |
| `HOST` | Default `127.0.0.1`. Reverse-proxy mode enforces loopback binding. Direct TLS may use `0.0.0.0`. |
| `PORT` | Default `8787`. |
| `GENERATION_DAILY_GLOBAL` | Default `50` attempts per UTC calendar day, across all anonymous clients. |
| `GENERATION_DAILY_IP` | Default `5` attempts per IP per UTC calendar day. |
| `MAX_CONCURRENT_GENERATIONS` | Default `2`, maximum `10`. |

Optional standard `HTTPS_PROXY`/`HTTP_PROXY` and CA environment variables are honored by `node --use-env-proxy` where a managed environment requires them. Keep TLS verification enabled. The included `.env.example` is documentation only; the server does not load dotenv files automatically.

## Deploy to one Linux host with persistent storage

This workspace has no public hostname or server credential configured. The implementation is ready; **deployment and live verification remain required**. The owner must provide DNS/hosting and provision the key server-side. No credential value is needed in the Android build.

1. Provision a Linux host with Node.js **24+**, systemd and Caddy **2.10+**. Point an owner-controlled DNS hostname at it. Allow public ports 80/443 for Caddy and outbound HTTPS to Lovable and returned image storage hosts. Keep the relay's port 8787 private.
2. Copy this `relay/` directory to `/opt/ai-emoji-relay`. Run these host commands from the extracted `relay/` directory with administrative access:

```sh
sudo useradd --system --home /var/lib/ai-emoji-relay --shell /usr/sbin/nologin ai-emoji-relay
sudo install -d -m 0755 /opt/ai-emoji-relay
sudo cp -R src scripts deploy test package.json package-lock.json /opt/ai-emoji-relay/
sudo install -d -m 0700 /etc/ai-emoji-relay
sudo install -d -o ai-emoji-relay -g ai-emoji-relay -m 0700 /var/lib/ai-emoji-relay
sudo install -m 0644 /opt/ai-emoji-relay/deploy/ai-emoji-relay.service /etc/systemd/system/ai-emoji-relay.service
```

3. Provision `/etc/ai-emoji-relay/secrets.env` from your secret manager, containing the `EMOJI_API_KEY` environment binding. Set its owner to root and mode to `0600`. The systemd manager reads this protected file before switching to the service user. Do not enter a credential in a command that would place it in shell history. On a managed hosting provider, bind the secret as a server-only environment variable instead.
4. Replace `relay.example.com` in `deploy/Caddyfile` with the actual hostname. Install it as `/etc/caddy/Caddyfile`, or merge its site block with an existing Caddy configuration. Caddy terminates TLS and overwrites forwarded client-IP/protocol headers. The relay trusts these headers **only** from its loopback proxy in explicitly configured reverse-proxy mode.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now ai-emoji-relay
sudo systemctl reload caddy
curl --fail --silent --show-error https://YOUR_RELAY_HOST/healthz
```

5. Keep the SQLite volume across restarts/deployments; quotas and session hashes persist. Deploy **one process/instance** for V1. Do not autoscale independent copies or use ephemeral SQLite volumes; that would bypass shared cost limits. Multi-instance deployment requires a shared transactionally updated store and distributed concurrency limits.
6. Open Android → Settings → Secure emoji relay → enter `https://YOUR_RELAY_HOST` → Connect relay. No APK rebuild is required for the URL. Alternatively, package only the public URL using `./gradlew assembleDebug -PrelayBaseUrl=https://YOUR_RELAY_HOST`.
7. Run the live verifier below, then verify generation/keyboard use on a phone. Bad upstream credentials/access policy yield a safe 503; correct the server configuration and restart the service. The app refreshes rejected sessions once, but never retries a possibly charged 5xx generation automatically.

## Verification commands

Local automated HTTPS components (requires Node 24 and OpenSSL):

```sh
npm test
```

The tests generate temporary TLS certificates and a synthetic server credential, inject controlled upstream responses, then delete the TLS fixtures. They assert the exact Lovable destination and server-only Authorization header. They are not live Lovable generation and do not demonstrate image quality.

Start direct HTTPS locally using certificate/key paths supplied by the server operator:

```sh
TLS_CERT_FILE=/path/to/cert.pem TLS_KEY_FILE=/path/to/key.pem \
RELAY_DB_PATH=/persistent/path/relay.sqlite npm start
```

Without `EMOJI_API_KEY`, the server deliberately runs in fail-closed mode: health 503, session issuance 503, generation 503, and no call to Lovable. A locally generated self-signed certificate is suitable only for local test clients that explicitly trust it. The Android production client uses normal platform certificate validation; no test CA is shipped in the APK.

Once deployed and the secret is bound:

```sh
RELAY_BASE_URL=https://YOUR_RELAY_HOST npm run verify:live
```

This issues a session, submits **BMW M4 in Marina Bay Blue**, downloads the returned PNG without Authorization, checks its signature/IHDR and 1024×1024 dimensions, and writes the PNG plus a safe verification report to `live-verification/`. It never logs session tokens, backend credentials or signed URLs. The source routes the live request to the unchanged Lovable generator. The verifier spends one actual generation attempt and is not a mock.

## Abuse limits and privacy

Anonymous issuance is intentionally public; it does not prove that the caller is an authentic Android app. V1 therefore includes conservative server-enforced quotas and a global cost budget. Increasing these for public scale requires stronger user/device verification and suitable operational limits.

Limits are persistent and transactional: 30 requests/IP/minute; 300 requests globally/minute; six issued sessions/IP/hour; twelve/IP/day; 100 sessions globally/hour; two generation attempts/session/minute; five/session/hour; five/IP/day and fifty globally/day by default. Shared Wi-Fi/NAT users share the IP quota. Generation attempts count even if the upstream fails, so failed attempts cannot bypass cost protection. 429 includes Retry-After. Limits use fixed UTC windows and survive service restarts.

Bodies are limited to 4096 bytes; prompts to 500 UTF-16 characters; style to `Soft 3D`; extra fields, compressed requests, control characters and invalid JSON are rejected. Upstream reads are bounded to 64 KiB and 150 seconds; redirects are refused so credentials cannot be forwarded to another server. PNG URLs must be safe HTTPS URLs; response bodies/errors are never forwarded wholesale. Unknown fields and any known credential appearing in a safe field are suppressed.

SQLite stores only token hashes, expiries, quota counters, and a private random IP-hash pepper. It stores no prompts, messages or raw IPs. Tokens, prompts, request bodies and upstream errors are not logged. HTTPS, body/time limits, and loopback-only trusted proxy configuration are required; never expose the unencrypted reverse-proxy port publicly.
