# Security policy

Please report vulnerabilities privately to the project operator rather than opening a public issue. Include the affected endpoint or media workflow, reproduction steps, and expected impact.

The original archive is outside the web trust boundary. A report showing that a browser can obtain an archive path, bypass a generation-scoped playback token, cause a worker to write outside its configured output root, or execute a source filename through a shell is considered critical.

Production deployments must use patched Node.js, FFmpeg, PostgreSQL, Redis, and Nginx releases and rotate playback/admin secrets after any suspected disclosure.
