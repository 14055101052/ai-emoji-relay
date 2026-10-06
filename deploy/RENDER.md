# Render Web Service deployment

Use the existing relay as a **Node Web Service**. Render terminates public HTTPS and forwards private HTTP to Node. No Caddy, certificate files, or TLS private key are needed in this mode. Android still uses the public HTTPS URL and normal certificate validation.

## Render Free: controlled development only

Ephemeral SQLite can be used for development if you deliberately choose `RELAY_STORAGE_MODE=ephemeral-development` and `NODE_ENV=development`. Other Render configurations fail startup rather than silently assuming durability. Startup emits a development-only warning.

Session tokens remain random, hashed server-side, short-lived, and authenticated before forwarding. Validation, quotas, response filtering, credential isolation and privacy remain enabled. **However, a filesystem reset deletes session hashes, the IP-hash pepper, and every quota/cost counter.** Existing Android tokens then receive 401 and refresh automatically. Budgets can be spent again after a reset. A process restart with the same files may retain SQLite, but Free offers no durable guarantee: spin-down, replacement, restart or redeploy can lose files. Free spin-down/cold starts may also delay Android requests.

This is appropriate for a small, controlled development test, with conservative limits and a separate backend-side spending cap if available. It is **not a production cost boundary** and should not be published for unrestricted use. Reducing daily limits does not solve reset-based budget bypass. Never configure `NODE_ENV=production` with ephemeral development mode; startup rejects that combination.

## Exact Render setup

1. Put the source in your Git repository and choose **New → Web Service → Node** on Render. For the complete Android/source repository, set **Root Directory** to `relay`. For the relay-only archive, commit the contents of its `relay/` folder at the repository root and leave Root Directory blank.
2. Choose the **Free** plan for development. Set **Build Command** to `npm ci --omit=dev` and **Start Command** to `npm start`. Set **Health Check Path** to `/healthz`.
3. Add these environment variables in Render's dashboard. The permanent key belongs only in the server's secret environment binding; do not commit an environment file containing it or add it to Android configuration.

| Variable | Render Free development value |
| --- | --- |
| `NODE_VERSION` | `24.19.0` (Node 24+ required) |
| `TLS_TERMINATION` | `render` |
| `NODE_ENV` | `development` |
| `RELAY_STORAGE_MODE` | `ephemeral-development` |
| `RELAY_DB_PATH` | `/tmp/ai-emoji-relay/relay.sqlite` |
| `GENERATION_DAILY_GLOBAL` | `5` (development cost cap per surviving database) |
| `GENERATION_DAILY_IP` | `5` (shared ingress scope, described below) |
| `MAX_CONCURRENT_GENERATIONS` | `1` |
| `EMOJI_API_KEY` | Bind the existing Lovable key as a server-only secret. No value belongs in source, chat or APK. |
| `LOVABLE_GENERATE_URL` | `https://project--a55e5977-6867-4325-9a5e-5e9efbb3a82c-dev.lovable.app/api/public/emoji/generate` (required server-side URL; no fallback) |

Leave `HOST` unset; Render mode binds **0.0.0.0**. Read Render's injected `PORT` (normally 10000); do not hardcode or override it. Do not set `TLS_CERT_FILE`, `TLS_KEY_FILE`, or `RENDER` yourself. Render injects `RENDER=true`, which this mode requires as a configuration guard, not cryptographic proof of ingress identity. An old `HOST=127.0.0.1` or old Caddy/direct-TLS settings will cause startup to reject the configuration.

4. Redeploy the updated source. Render's existing `LOVABLE_GENERATE_URL` binding is now read and validated; retain/set the development value in the table above. Missing/invalid/non-public-DNS URL configuration fails startup, before opening a listener. Only this project's development/production HTTPS generation hosts are allowed; no endpoint configuration is taken from Android. `/healthz` returns only `{"ready":true}` when the server secret is configured. Without the secret it returns 503, and Render's readiness check will fail; configure the secret before expecting a healthy deployment. A 200 readiness check does not prove Lovable accepts the key. Android and the APK need no change for this upstream routing fix.
5. With the deployed HTTPS origin, check routes from your workstation:

```sh
curl --fail --silent --show-error https://YOUR_SERVICE.onrender.com/healthz
RELAY_BASE_URL=https://YOUR_SERVICE.onrender.com npm run verify:live
```

Run the second command from the local `relay/` source directory using Node 24. It obtains a session, submits **BMW M4 in Marina Bay Blue**, verifies/downloads a real 1024×1024 PNG and writes a safe report. It spends one real generation attempt and does not print credentials or signed URLs. In Android Settings → Secure emoji relay, enter `https://YOUR_SERVICE.onrender.com` and Connect relay. No Android/APK change is required.

## Proxy trust and quotas

Only explicit `TLS_TERMINATION=render` relaxes the old loopback/direct-TLS requirement. Protected API routes require an exact single `X-Forwarded-Proto: https` value from Render's ingress; missing, HTTP or comma-separated values are rejected with 403. The exact read-only `GET /healthz` route also accepts Render's internal HTTP probe without that header. No session/generation route gets this exemption.

**The trust boundary is Render's managed ingress and isolated private network.** Forwarded headers alone are not an authentication mechanism. Keep this mode on Render, expose only the Web Service, and treat services/operators with access to its private network as trusted. Do not reuse this mode on a directly public HTTP server. The injected `RENDER` flag is only an accidental-misconfiguration guard. Caddy's old loopback-only mode and direct HTTPS behavior remain unchanged.

To avoid depending on undocumented client-IP forwarding chains, the service **ignores `X-Forwarded-For`, `Forwarded`, and similar identity headers** in Render mode. It uses one stable `render-shared-ingress` scope for the existing IP quotas. All users therefore share 30 requests/minute, 6 sessions/hour, 12 sessions/day, and the configured IP generation/day quota. This is intentionally conservative: forged IP headers and token rotation cannot bypass those counters. Per-session, global, concurrency and request-validation limits still apply. No prompts, raw client IPs, tokens, upstream errors or secret values are logged or stored in SQLite; only existing hashed sessions, hashed scope/pepper and counters are stored. The relay contains no request-logging middleware; avoid adding request/body/Authorization logging in hosting integrations.

For public scale, add a verified client-identity/proxy policy or authenticated users with persistent shared quotas; do not simply trust a caller-supplied first IP or increase limits to hide shared-bucket contention.

## Before production

Choose either:

- **Paid Render service with attached persistent disk:** mount at `/var/data`, set `RELAY_DB_PATH=/var/data/ai-emoji-relay/relay.sqlite`, `RELAY_STORAGE_MODE=persistent`, `NODE_ENV=production`; keep `TLS_TERMINATION=render`. Run one instance/process and retain the disk across deployments. A paid instance without an attached disk is still ephemeral. An absolute database path is validated, but the code cannot prove that Render mounted a durable disk—verify the disk attachment and persistence yourself.
- **External durable database/limit store:** implement transactional shared session/counter storage (for example durable Postgres), plus distributed concurrency control before running multiple instances. This is an architectural follow-up, not implemented by this change. Render Free plus the current local SQLite is insufficient for production.

Before release, test disk persistence across service replacement/redeploy, token rejection/expiry and quotas, the actual Render HTTPS/header behavior, secret isolation, backend errors and the real BMW PNG flow. Retain the Android privacy boundary: only explicitly submitted Create Emoji prompts reach the relay. No Lovable/provider/client shared credential is introduced by Render mode.

Routes remain `GET /healthz`, `POST /api/auth/session`, and authenticated `POST /api/emoji/generate`. This workspace's tests exercise Render-style private HTTP forwarding, not a deployed Render service; the owner must complete the live checks after deployment.

References: [Render Web Services](https://render.com/docs/web-services), [Free instances](https://render.com/docs/free), [persistent disks](https://render.com/docs/disks), [default environment variables](https://render.com/docs/environment-variables), [Node versions](https://render.com/docs/node-version).
