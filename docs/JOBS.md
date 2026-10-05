# Import jobs

The API hands slow work to the Python worker through the `import_jobs` table. The
API inserts a row with `status = 'queued'`. A worker claims it with
`SELECT … FOR UPDATE SKIP LOCKED`, runs it, and records the outcome.

This file is the contract between `app/src/jobs/` (which enqueues jobs) and
`worker/src/homebuilder_worker/handlers.py` (which runs them). Change both sides
together.

## Lifecycle

```
queued ──claim──▶ running ──▶ succeeded            (result = JSON counts)
                     │
                     ├──▶ failed                    bad input: never retried
                     └──▶ queued (attempts < max)   network or YouTube errors, crashes
```

- `attempts` counts claims. After `JOB_MAX_ATTEMPTS` (default 3) a retryable
  failure becomes `failed`.
- A retried job waits before it can be claimed again: 1 minute after its first
  attempt, then 5, then 25. This gives YouTube outages and rate limits time to
  clear.
- A job stuck in `running` for longer than `JOB_STALE_MINUTES` (default 30)
  belongs to a worker that died. It is re-queued, or failed if it has no
  attempts left.
- `error` is a short message that is safe to show to users. Stack traces go to
  the worker log only.

## Job types

| `type` | `house_id` | `payload` | What it does |
|---|---|---|---|
| `paste_import` | NULL (shared) or a house | `{"text": string}`: one URL or bare ID per line, at most 500 lines; `#` comments and blank lines are skipped | Adds the videos |
| `csv_import` | NULL or a house | `{"csv": string}`: Google Takeout playlist CSV (a "Video ID" column), or any CSV containing YouTube URLs | Adds the videos |
| `playlist_sync` | NULL only | `{"playlistId": number}`: `playlists.id` | Lists the playlist with `yt-dlp --flat-playlist`, adds new videos, updates the playlist title and `last_synced_at` |
| `metadata_refresh` | NULL | `{"videoIds"?: number[]}` (all pending videos when omitted) | Retries oEmbed for videos whose metadata is `pending` |
| `apply_rules` | NULL | `{}` | Re-runs keyword rules over every video in the inbox, replacing earlier suggestions. Confirmed links are kept. |

When `house_id` is set, imported videos are private to that house. A video that
is already in the shared library is skipped and counted as `alreadyShared`.

## Result

The import types (`paste_import`, `csv_import`, `playlist_sync`) return:

```json
{
  "added": 12, "duplicates": 3, "alreadyShared": 0,
  "unavailable": 1, "pendingMetadata": 0, "suggested": 20,
  "invalidCount": 1, "invalid": ["not a link"]
}
```

`invalid` lists at most 50 of the rejected lines or cells. `playlist_sync`
also returns `playlistEntries`.

`metadata_refresh` returns
`{"checked", "ok", "unavailable", "pending", "suggested"}`.

`apply_rules` returns `{"videos", "suggested"}`.

## Nightly sync

At `SYNC_TIME` (default `03:00`, in the worker's `TZ`), one worker enqueues a
`playlist_sync` for every playlist, plus a `metadata_refresh`. These jobs are
created by `system:nightly`. A MySQL named lock and a check for jobs already
created today make sure this happens once per day, however many workers run and
however often they restart. A worker that was down at the sync time catches up
when it starts.
