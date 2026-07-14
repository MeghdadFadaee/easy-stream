# Operations

## Interactive Ubuntu bootstrap

After cloning the repository on an Ubuntu server, run:

```sh
bash scripts/setup-ubuntu.sh
```

The bootstrap uses Docker's signed Ubuntu apt repository, prompts for production values without echoing secrets, optionally generates 256-bit secrets, creates a mode-`0600` `.env`, and validates Compose before it offers to start the stack. It refuses overlapping archive/cache/derived/metadata paths and warns when the host archive mount is writable or the configured cache exceeds available disk space. Its gateway bind address defaults to `127.0.0.1`; select `0.0.0.0` or a specific interface only when network-level origin restrictions are ready.

The script intentionally does not add the operator to the `docker` group because that group grants root-equivalent privileges. It uses `sudo` for Docker when needed. It also leaves DNS, HTTPS termination, CDN authorization, firewall policy, storage mounting, and backup automation to the operator.

If the initial image build is interrupted by a temporary registry or network failure, the configuration and generated `.env` remain valid. After the connection recovers, resume without rerunning setup:

```sh
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

The Docker build pins pnpm and gives npm downloads bounded retries and a five-minute request timeout. BuildKit caches the npm and pnpm stores between attempts, so successfully downloaded packages are reused.

When outbound access requires a proxy, enter its URL during setup. A proxy listening on host loopback, such as `http://127.0.0.1:8118`, automatically selects host networking for Dockerfile `RUN` steps so that loopback resolves to the server. Proxy values are passed through Docker's predefined build arguments and are not persisted in the resulting images. This setting affects build downloads only; image pulls still use the Docker daemon's own proxy configuration.

## Host layout

- `/srv/easy-stream/archive`: read-only archive mount
- `/srv/easy-stream/cache`: 2 TB NVMe hot package cache
- `/srv/easy-stream/derived`: persistent compatibility components
- `/srv/easy-stream/metadata`: extracted subtitles, approved fonts, and cached metadata
- Docker named volume `postgres-data`: PostgreSQL data (PostgreSQL 18 layout)

Use a dedicated unprivileged service account. Confirm the archive mount is read-only with `findmnt -no OPTIONS /srv/easy-stream/archive` before starting workers.

Create bind-mount destinations before the first Compose start; otherwise Docker may create root-owned directories that UID/GID 1000 cannot write:

```sh
sudo install -d -o 1000 -g 1000 -m 0750 \
  /srv/easy-stream/cache \
  /srv/easy-stream/derived \
  /srv/easy-stream/metadata
```

Use one public HTTPS origin for the SPA, API, and media routes. The v1 playback grant is a host-only, generation-path cookie, so a second media hostname will not receive it. A split hostname requires CDN-native edge authorization instead.

The API and media worker run as UID 1000, and the gateway's Nginx workers are configured to the same UID for read-only media access. Keep the bind mounts owned by that account rather than making generated media world-readable.

## Required production gates

1. Complete the archive census and size the durable derived volume to 125% of the projected output.
2. Validate current and previous-two Chrome/Firefox releases plus the named physical TV test devices.
3. Load test 1,000 concurrent playback patterns through the selected CDN.
4. Restrict origin ingress to the CDN and administration network.
5. Replace all bootstrap credentials and signing secrets.
6. Confirm movie, audio, subtitle, font, poster, and territorial distribution rights.
7. Confirm a written TMDB commercial agreement before using TMDB in a commercial production service.
8. Run migrations against an empty PostgreSQL database and verify API/worker startup before importing the archive.

## CDN authorization

The origin sends `Cache-Control: private` for immutable media and `no-store` for manifests. Keep that behavior for initial deployment. Forwarding the playback cookie to the origin secures only cache misses; it does not protect a shared cache hit.

Enable shared media caching only after the chosen CDN validates a signed cookie or URL before cache lookup and rejects expired grants. Keep manifests uncacheable, cache generation assets by their canonical path after authorization, restrict direct origin ingress to the CDN, and test unauthorized warm-cache requests as part of acceptance.

Before relying on per-client rate limits or logs, configure Nginx `real_ip_from` only for the selected CDN's published address ranges and map its authenticated client-IP header. The safe default discards client-supplied forwarding chains, which means an unconfigured CDN will otherwise group viewers by edge address.

## Cache lifecycle

Playback creation writes a Redis lease through the session expiry and queues a metadata touch. After a successful JIT package, the worker sweeps from the configured high watermark down to the low watermark. It skips active, building, pinned, recently built, or leased generations, removes evicted registry entries atomically, and prunes aged unreferenced global fonts. Durable files under `DERIVED_ROOT` are outside this lifecycle.

Manual eviction is intentionally refused while a generation has an active lease. If cache pressure cannot fall below the target because every candidate is protected, add capacity or wait for sessions to expire; never remove generation directories by hand while viewers are active.

## Backups and recovery

- Back up PostgreSQL and deployment configuration every night and test restoration monthly.
- Cache media is disposable and must not be backed up.
- Metadata and subtitles are reproducible, but snapshots reduce archive rereads.
- Derived compatibility media is reproducible but expensive; snapshot it according to recovery-time requirements.
- On source replacement, retain an active old generation until its playback cookies expire, then evict it.
- Keep Redis persistence enabled: cache leases are written synchronously before a READY session is returned, then mirrored into generation metadata by the worker. The four-hour recency grace also protects a newly completed cold package before its first poll.

## Alerts

Alert on API 5xx rate, playback-session failures, FFmpeg failures, job age, cache pressure, derived disk pressure, archive I/O latency, cold-start p95, origin throughput, invalid signed-cookie spikes, and client fatal-player events.
