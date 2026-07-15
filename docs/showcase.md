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

## Portable static deployment

Create one self-contained folder with the viewer, catalog, artwork, subtitles, fonts, and converted HLS media:

```sh
corepack pnpm showcase export-static
```

The default output is `dist/showcase-static`. Change it in `.env.showcase` with `SHOWCASE_EXPORT_ROOT`, or for one run:

```sh
corepack pnpm showcase export-static --output ./release/showcase
```

This one command rescans the archive, sequentially prepares missing compatible media, removes stale generations, builds the viewer, and replaces the previous managed export. Existing files are hard-linked when the destination is on the same filesystem, so creating an export normally consumes almost no additional local disk space. Copying is used automatically when hard links are unavailable. The exported folder itself is portable; an upload tool reads the linked files just like ordinary files.

Preview the exact static release before uploading it:

```sh
corepack pnpm showcase preview-static
```

Then upload everything inside `dist/showcase-static` to Vercel static hosting, Netlify, Cloudflare Pages, an S3-compatible static bucket, shared hosting, or a normal Caddy/Nginx document root. Routes use URL hashes (`/#/title/example`), so no SPA rewrite rule is needed and the folder may be hosted below a subdirectory.

The host must serve the folder over HTTP or HTTPS; browsers cannot reliably stream it by opening `index.html` through `file://`. Ensure these MIME mappings are available:

| Extension | Content-Type |
|---|---|
| `.m3u8` | `application/vnd.apple.mpegurl` |
| `.m4s` | `video/iso.segment` |
| `.mp4` | `video/mp4` |
| `.vtt` | `text/vtt; charset=utf-8` |
| `.ass` | `text/plain; charset=utf-8` |

For Caddy, `file_server` provides the required static hosting. For Nginx, include the standard `mime.types` file and add `application/vnd.apple.mpegurl m3u8;` and `video/iso.segment m4s;` if the installed MIME table lacks them.

No Node.js, SQLite, Fastify, FFmpeg, API, database, or background process runs on the hosting service. All exported media is public by design; never include private or access-controlled titles in this Showcase workflow.
