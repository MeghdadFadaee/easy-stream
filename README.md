# Easy Stream

Easy Stream is a browser-first streaming layer for a read-only Matroska archive. It keeps the original MKV files untouched, remuxes compatible H.264/AAC sources to CMAF/fMP4 HLS only when requested, and bounds those generated files with a 2 TB LRU cache. Incompatible SDR sources can be prepared once as a durable, same-resolution H.264/AAC representation; HDR is held for review in v1.

The first version targets Chrome, Firefox, and modern MSE-capable Android TV browsers. The UI is guest-first, Persian/RTL by default, remote-control friendly, and stores viewer preferences and resume progress only in IndexedDB.

## Repository layout

- `apps/web`: Vue/Vite catalog, TV navigation, player, local progress, and admin UI.
- `apps/api`: Fastify catalog, playback sessions, signed media authorization, admin, and TMDB metadata endpoints.
- `apps/worker`: archive scanner, BullMQ worker, JIT packager, offline compatibility encoder, and cache maintenance.
- `packages/contracts`: closed TypeBox API, queue, snapshot, and registry contracts.
- `packages/media`: FFmpeg, subtitle, font, HLS validation, path-safety, and LRU primitives.
- `packages/database`: Drizzle schema, migrations, catalog synchronization, and job lifecycle helpers.
- `infra`: production Node/FFmpeg images and the same-origin Nginx gateway.

See [architecture.md](docs/architecture.md) for the media decisions and [operations.md](docs/operations.md) for deployment gates.

For a small, open demo that runs as one Node process with SQLite and no Docker, PostgreSQL, Redis, worker, queue, or admin panel, use the [Showcase edition](docs/showcase.md).

## What happens to a movie

| Source | v1 behavior | Storage |
|---|---|---|
| Browser-compatible H.264/AAC SDR | Stream-copy to progressive fMP4 HLS on first play | Bounded, disposable cache |
| H.264 SDR with incompatible audio | Copy video and encode audio to AAC | Bounded, disposable cache |
| Other SDR video | One offline H.264/AAC encode at the source resolution | Durable derived disk |
| HDR, Dolby Vision, invalid, or incomplete media | Not published | Original only |

ASS subtitles are preserved for JASSUB/libass rendering, with WebVTT fallback. Embedded fonts are validated, content-addressed, and exposed only inside the signed generation path.

## Local verification

Requirements: Node.js 24 LTS (22 is supported for development), pnpm 11 through Corepack, and FFmpeg/ffprobe 8.x.

```sh
cp .env.example .env
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm scan:samples
```

`scan:samples` writes a public `data/metadata/catalog.json` and a private `data/metadata/inventory.json`. Source paths and probe details never enter the public snapshot.

The production scanner also understands categorized, multi-quality archives:

```text
archive/<category>/<year>/<Spring|Summer|Fall|Winter|Movie>/<title>/<quality>/*.mkv
```

For example, `anime/2026/Summer/Mushoku Tensei S3/720/...mkv` becomes Anime → Mushoku Tensei → Season 3. Files for the same episode under `480`, `720`, `1080`, or codec-suffixed quality folders become selectable source variants rather than duplicate episodes. A `thumbnail.jpg`, `.jpeg`, `.png`, or `.webp` beside the quality folders is copied to the generated artwork store; the archive itself remains private and read-only. The older `Title S3/*.mkv` layout remains supported.

To package one scanned media item with the locally installed FFmpeg, copy its UUID from `inventory.json` and run:

```sh
node apps/worker/dist/cli.js package \
  --root ./archive \
  --cache ./data/cache \
  --inventory ./data/metadata/inventory.json \
  --registry ./data/metadata/package-registry.json \
  --media-item MEDIA_ITEM_UUID
```

The original file is opened read-only. Generated media is written under `data/cache/generations/<generation-id>`.

## Ubuntu / Docker Compose

On a fresh Ubuntu server, clone this repository and run the interactive bootstrap. It asks for the real HTTPS origin, storage paths, cache size, administrator account, passwords, signing secrets, concurrency, playback lifetime, and optional licensed TMDB access. Secret input is hidden; blank infrastructure secrets are generated securely.

```sh
chmod +x scripts/setup-ubuntu.sh
bash scripts/setup-ubuntu.sh
```

The script installs Docker Engine and the Compose plugin from Docker's official apt repository, asks which host address may expose port 8080 (loopback by default), creates the writable host directories for UID/GID 1000, backs up an existing `.env`, writes the replacement with mode `0600`, validates the rendered Compose configuration, and asks before building or starting containers. Use `--no-start` to configure without launching, or `--skip-docker-install` when a supported Docker installation already exists.

If you decline the offered Caddy step, the main bootstrap leaves DNS, TLS termination, and inbound firewall configuration untouched. CDN edge authorization, archive mounts, and backups remain separate production gates in either case.

To publish an already-running installation, use the separate domain bootstrap. It installs Caddy, configures automatic HTTPS, and proxies the public hostname to the loopback-only gateway:

```sh
bash scripts/setup-domain.sh
```

### Manual alternative

1. Copy `.env.example` to `.env` and replace every bootstrap password and signing secret. Keep `PLAYBACK_SIGNING_SECRET` and `MEDIA_AUTH_SHARED_SECRET` different.
2. Set absolute `ARCHIVE_ROOT`, `CACHE_ROOT`, `DERIVED_ROOT`, and `METADATA_ROOT` paths. The archive is mounted read-only.
3. Make the three writable directories available to UID/GID `1000:1000`, used by the unprivileged worker image.
4. Set `WEB_ORIGIN`, `PUBLIC_ORIGIN`, and `MEDIA_PUBLIC_BASE_URL` to the same public HTTPS origin. Put port 8080 behind the CDN/TLS edge and restrict direct origin access.
5. Start the stack:

```sh
docker compose build
docker compose up -d
docker compose ps
```

Compose waits for PostgreSQL, applies migrations once, then starts the API, worker, and gateway. On a new installation, open `/admin`, sign in with the bootstrap administrator, and start the first archive scan. The worker writes the snapshots and transactionally imports public catalog rows into PostgreSQL.

Cold playback is automatic. For a media item classified `VIDEO_TRANSCODE`, run the deliberate offline preparation command before publishing it:

```sh
docker compose exec worker node apps/worker/dist/cli.js prepare \
  --root /archive \
  --derived /data/derived \
  --inventory /data/metadata/inventory.json \
  --registry /data/metadata/package-registry.json \
  --media-item MEDIA_ITEM_UUID
```

## Important v1 boundaries

- There is no adaptive-bitrate ladder. Viewers may manually select an available source quality; each selection is packaged independently on demand and never switches automatically.
- Compatible media still occupies temporary HLS cache space; “no duplication” means no permanent HLS copy for every title.
- Durable compatibility encoding is intentionally operator-controlled and CPU-limited to one job at a time.
- TMDB stays disabled until both an API token and explicit commercial-license confirmation are configured.
- The gateway deliberately marks media responses `private`. Do not override that at a CDN until the CDN validates a signed playback grant **before every cache lookup**; merely forwarding the cookie on cache misses is not authorization.
- Physical Android TV, CDN, Redis/PostgreSQL failure recovery, incompatible-SDR encoding, and the full 100 TB census remain production acceptance gates.
