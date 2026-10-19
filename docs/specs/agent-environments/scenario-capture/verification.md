# Verification

Verified commit: 3c2a8db2, this increment on top of the environment-export increment (481c9883).

## Gates

Run on macOS 26.5.1 with Node 22.23.1 on that tree:

- `npx tsc --noEmit`: no errors.
- `oxfmt --check`: all files formatted. `oxlint` on the changed files: no new findings.
  `npm run verify:module-boundaries`: 2133 files checked.
- `npm run jscpd`: 3.35% duplicated lines, unchanged. `npm run scan:todos`: none.
  `npm run mcp-catalog:check`: passed. `npx knip`: one unresolved import that predates
  this change (`#javascript-analysis-worker`).
- `npm run test:prepare`, then vitest over `src/domain/analysisView`, `src/application`,
  `src/contracts`, `src/server/environment`, `tests/conformance` and the analysis-view,
  environment-serve, environment-export and browser-scenario boundary tests: 1946 tests in
  157 files, 1941 passed, 5 skipped, 0 failed.

## Real browser captures

`npm pack` of this commit (`rea-agents-6.7.0.tgz`) was installed on Ubuntu 24.04 amd64 hosts
(8 vCPU, 32 GB) with Chromium 155.0.8059.79 at `/snap/bin/chromium`, Node 24, Docker and
`agentenv-framework` 0.9.1334. Every capture below is `rea capture-browser-scenario` output;
no HAR was recorded, scoped or edited.

### Fixture

A loopback fixture served a page that lists photos from `/api/photos`, three PNG thumbnails, and
a form that POSTs JSON to `/api/albums`. The scenario waited for the list, opened
`/api/photos/1..3` with `goto`, filled and submitted the form.

- Capture: 14 transactions, 70 events, 0 dropped, authority `controlled-replay`.
- `environment-manifest`: `parent_operation` `capture_browser_scenario`, origin
  `http://127.0.0.1:3199`, confidence `inferred`. Tools `get_photos` (records 1, 9),
  `get_photos_by_id` (`{numeric}` id, records 5, 6, 7) and `post_albums` (record 13, body shape
  `title: string`). The page and the three PNGs were excluded as `ui-page-or-asset`.
- `environment-serve`: `get_photos_by_id {id: "3"}` returned the recorded JSON with
  `record_ordinal` 7 and `exact_match` true.
- The POST's response body was missing: the scenario ended at the action that sent it, the
  transaction was still unfinished, and the observer does not read bodies of unfinished
  responses. The manifest stated "1 of 14 scenario transactions retained no response body" and
  `post_albums` replayed status 201 with no body. Ending the scenario with a 1.5 s
  `wait_for_timeout` finished all 14 transactions and retained the body.
- `environment-export` of that capture wrote a README naming the browser scenario capture and the
  scenario definition's SHA-256; `agent-env run <bundle> --task smoke` passed in 30.4 s.

### Five applications

Each environment ran manifest, export, the bundle's smoke task and 6 to 12 generated retrieval
tasks, with one run per task for two models through the Hugging Face router.

| Application                  | Capture                                                            | Actions | Transactions | Tools (rules / none) | Smoke  | Retrieval tasks | gpt-oss-120b | GLM-5.3-Flash |
| ---------------------------- | ------------------------------------------------------------------ | ------- | ------------ | -------------------- | ------ | --------------- | ------------ | ------------- |
| PhotoPrism 261007            | self-hosted, no login (public mode)                                | 55      | 277          | 13 / 28              | passed | 10              | 10/10        | 10/10         |
| Lychee 6.10.4                | self-hosted, session cookie seeded from a declared secret          | 152     | 134          | 15 / 27              | passed | 12              | 11/12        | 12/12         |
| Pinry 2.1.13                 | self-hosted, session and CSRF cookies seeded from declared secrets | 148     | 568          | 12 / 12              | passed | 6               | 6/6          | 6/6           |
| Art Institute of Chicago API | public, `goto` per URL                                             | 52      | 26           | 11 / 12              | passed | 12              | 11/12        | 12/12         |
| Library of Congress JSON API | public, `goto` per URL                                             | 55      | 29           | 11 / 11              | passed | 12              | 11/12        | 12/12         |

Every scenario step completed and no capture dropped events. Each self-hosted capture includes
one create, one edit and one delete made through the application's own forms; all three became
tools with their recorded statuses, including a 204 DELETE without a content type. Declared
secrets did not appear in any capture; where the application echoed a declared value in a
response body (PhotoPrism's session reply, Pinry's owner token) the capture held the redaction
marker instead.

Two other targets were tried and replaced. The Met Collection API projected 3 tools: its data
paths are `/departments`, `/objects/{id}` and a search, and numeric object ids merge into one
tool. The NASA Image and Video Library projected 16 tools, but its Collection+JSON bodies nest
record fields deeper than the task generator reads, so no tasks could be derived.

## Observed limits

These were observed during the runs and are outside this increment:

- A scenario's last action can lose its response body unless the scenario ends with a wait
  (above).
- Large asset bodies count against the analysis-view budget. One Pinry capture at
  `max_network_body_bytes` 262144 held 12.5 MB of Evidence, mostly CSS and JavaScript reloaded
  on 33 page loads, and the manifest view returned `resource_constraint`. A 20,000-byte body
  limit kept it within budget. Scenarios have no per-origin or per-media-type body selection.
- Image responses outside an API path are excluded as UI assets, so their bytes are replayable
  only when an API path serves them (PhotoPrism's `/api/v1/t/...` tiles became tools).
- With the default `max_total_event_allocation_bytes`, one PhotoPrism capture dropped its last
  68 transactions, including all three writes, while the command exited 0; 64 MiB dropped none.
- Actions have no default deadline: two runs waited on a locator for 277 s and 7.5 min until
  cancelled. Every scenario above sets `timeout_ms` on its actions.
- A redirect is its own transaction; Django's trailing-slash 301 produced a second tool
  (`get_pins_by_id` and `get_pins_by_id_2`) for one resource.
