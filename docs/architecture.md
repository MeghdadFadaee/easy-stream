# Easy Stream architecture

## Runtime topology

```text
Browser / TV browser
        |
        v
CDN (production, provider managed externally)
        |
        v
Nginx gateway ───────> Vue SPA
   |       |
   |       └─────────> versioned CMAF/HLS cache
   v
Fastify API ─────────> PostgreSQL
   |                       |
   └───────────────> Redis/BullMQ
                           |
                           v
                    FFmpeg media worker
                       |          |
                       v          v
                 read-only MKV   cache/derived volumes
                    archive
```

The archive is never exposed over HTTP and is never writable by an application container. Nginx serves only generated, versioned media after a signed playback-cookie check. Media is private-cache by default. A production CDN may turn on shared caching only when its edge validates an equivalent grant before checking its cache; forwarding a cookie only on an origin miss is insufficient.

## Media lifecycle

1. The worker walks regular `.mkv` files under `ARCHIVE_ROOT`, rejects escaping symlinks, derives category/year/release-window/title identity from the archive hierarchy, fingerprints each source variant, and records ffprobe stream metadata.
2. Sources are classified as `COPY`, `AUDIO_TRANSCODE`, `VIDEO_TRANSCODE`, `HOLD_HDR`, or `INVALID`.
3. Publication is allowed immediately for `COPY`; incompatible SDR media must finish its single H.264/AAC compatibility representation first. HDR is held in v1.
4. A movie or episode may have several source-quality variants. Auto prefers 720p and viewers may change quality explicitly; a cold playback request creates one packaging job per selected source/profile fingerprint. FFmpeg copies supported elementary streams to separate fragmented-MP4 HLS playlists.
5. EVENT manifests may grow privately, but the registry remains `PREPARING` until HLS, subtitles, and generation-scoped fonts are all ready. The worker then publishes one complete `READY` record and finalizes immutable VOD playlists.
6. Compatible generations live in the 2 TB LRU cache. A playback session records a Redis lease and persistent access timestamp through the signed-cookie expiry; high/low-watermark sweeps skip leased, building, pinned, and recently touched entries. Encoded compatibility components live on separately sized durable storage and are never swept.
7. Eviction removes the matching package-registry entry so the next request regenerates it. Aged global font objects with no generation hardlinks are pruned during packaging sweeps.

There is deliberately no adaptive bitrate ladder. Quality changes are explicit, preserve the logical-media resume position, and create independent cache generations. Devices that reject every available representation receive a clear compatibility error.

## Trust boundaries

- Archive filenames, Matroska flags, subtitle text, fonts, and metadata are untrusted input.
- FFmpeg and ffprobe are spawned with argument arrays and no shell.
- Worker processes run unprivileged with a read-only archive and receive only their database, Redis, path, and media settings—not playback, administrator, media-auth, or TMDB secrets. FFmpeg/ffprobe children receive a further allowlisted environment without database or Redis credentials.
- Generated paths use server identifiers rather than source filenames.
- The gateway applies CSP, COOP, COEP, nosniff, frame, and referrer protections.
- Playback cookies are scoped to one media generation and expire after four hours.
- Viewer state stays in IndexedDB; there is no viewer identity database in v1.

## Scale boundaries

The first deployment targets 1,000 peak concurrent viewers behind a CDN. JIT packaging defaults to two concurrent jobs and compatibility encoding to one CPU-limited job. PostgreSQL, Redis, the API, workers, cache, and gateway have explicit boundaries so they can be moved to separate hosts without changing public API contracts.

The implemented scanner produces codec/HDR compatibility, duration, stream, subtitle, and fingerprint inventory. Before production disk capacity is purchased, extend the archive census with measured GOP distribution, corruption sampling, aggregate bitrate, and projected derived-storage reports; those expensive archive-wide reports are an acceptance gate, not part of the request-time path.
