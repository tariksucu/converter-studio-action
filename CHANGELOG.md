# Changelog

## 1.0.0

First release.

- Converts the files that paths and glob patterns match (`!` leaves files out) to one target format
  with the Converter Studio API, several at a time (`concurrency`), and writes each result next to
  its source or below `output-dir`, keeping the folders below the patterns.
- `options` takes the API's conversion options as a JSON object; `max-credits` caps what one file
  may cost.
- `if-exists`: `skip` (default: an existing result is kept and its source is not converted),
  `overwrite` or `fail`.
- Outputs: `files`, `map` (source → result), `skipped` and `failed`.
- Checks the API key once before converting; checks the target and each file's format against the
  API's format list before uploading; never lets two sources share a result or a result replace a
  source.
- Uploads large files in parts of 95 MiB; waits out rate limits and busy servers; sends an
  Idempotency-Key, so a request sent again after a lost answer never starts a second conversion;
  writes each result whole or not at all.
- Runs on Node 24 (`runs.using: node24`).
