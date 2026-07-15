# Showcase edition

The Showcase edition is the small-server path for a few demo anime. It is a single Fastify process, a local SQLite file, the existing Vue catalog/player, and one operator CLI. It has no accounts or playback cookies: every prepared title is openly playable from the server's HTTP address.

## Requirements

- Ubuntu 24.04 or another current Linux distribution
- Node.js 24 and Corepack
- FFmpeg and ffprobe 8.x

Install dependencies and create the local configuration:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.showcase.example .env.showcase
```

For direct LAN/public-IP testing, set these values in `.env.showcase`:

```dotenv
SHOWCASE_ARCHIVE_ROOT=./archive
SHOWCASE_DATA_ROOT=./data/showcase
SHOWCASE_HOST=0.0.0.0
SHOWCASE_PORT=8080
```

`SHOWCASE_ARCHIVE_ROOT` and `SHOWCASE_DATA_ROOT` may be absolute paths. Relative paths are always resolved from the repository root, so commands behave the same when pnpm changes the package working directory.

## Archive layout

Use the same categorized layout as the full edition:

```text
archive/<category>/<year>/<season>/<title>/<quality>/*.mkv
archive/anime/2026/Summer/Mushoku Tensei S3/720/*.mkv
```

Put `thumbnail.jpg`, `.jpeg`, `.png`, or `.webp` in the title directory. Multiple quality directories for the same episode become selectable quality variants.

An optional `metadata.json` in the title directory can override filename-derived text:

```json
{
  "titleEn": "Mushoku Tensei",
  "titleFa": "موشوکو تنسی",
  "synopsisFa": "خلاصه کوتاه",
  "synopsisEn": "A short synopsis",
  "category": "Anime",
  "year": 2026,
  "releaseWindow": "SUMMER"
}
```

## Operator workflow

Build the guest-only viewer and the standalone CLI, scan the archive, then explicitly prepare media before serving it:

```sh
corepack pnpm showcase:build
corepack pnpm showcase scan
corepack pnpm showcase status
corepack pnpm showcase prepare --all
corepack pnpm showcase serve
```

Open `http://SERVER_IP:8080`. Only successfully prepared variants appear in the public catalog.

For a smaller update:

```sh
corepack pnpm showcase prepare --title mushoku-tensei
corepack pnpm showcase prepare --title mushoku-tensei --quality 720p
```

Preparation is sequential and operator-controlled. Compatible H.264/AAC is remuxed without video encoding; incompatible audio is converted to AAC; incompatible SDR video is converted once to H.264/AAC. HDR, Dolby Vision, and invalid media remain unpublished. Subtitles and embedded fonts are extracted into the generated media directory. Original MKV files are never modified.

After archive changes, run `scan` again. A changed source fingerprint resets that variant to `UNPREPARED`. Inspect failures with `status`, retry deliberately with `--force`, and preview or apply stale-generation cleanup with:

```sh
corepack pnpm showcase prune
corepack pnpm showcase prune --apply
```

SQLite, artwork, subtitles, fonts, and HLS generations live under `SHOWCASE_DATA_ROOT`. Back up that directory if the prepared demo state matters. The app itself does not terminate TLS; for a public domain, place Caddy or another HTTPS reverse proxy in front of port 8080.
