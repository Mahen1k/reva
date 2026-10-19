# Build environments from browser scenario captures

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

The `environment-manifest` view, `environment-serve` and `environment-export`
accept `capture_browser_scenario` Evidence as the manifest's parent, in
addition to `inspect_web_network_capture` HAR Evidence. A session REA records
itself, in a browser it launches, with credential headers and declared secrets
redacted, becomes an agent environment without an external capture script or
HAR scrubbing step. The replay, the tool surface and the bundle layout do not
change.

## Requirements

- A scenario parent is admitted only when its scenario selected
  `capture.network.response_body` or `header_values`, because tools are chosen
  by response media type; otherwise the view refuses with
  `unsupported_target`.
- Each network transaction becomes one record in request order; its ordinal
  is the zero-based position of its `request` event, and its location is the
  JSON pointer of that event in the capture. The record is shaped like a HAR
  entry: request method and URL, the request body as `postData` when it was
  captured and decodes as UTF-8, the response status, and the response media
  type with its retained bytes as base64 content and a retained binary field.
- A transaction whose URL the scenario redacted keeps a null URL, so no path
  template is formed from a redaction marker. A transaction that does not
  resolve to exactly one request event, at most one response event and at most
  one content event per phase keeps no request line. Both are counted as
  unrepresented records, as HAR records without a usable request line are.
- The response media type is the captured body's `media_type`, or the
  `content-type` header value when only headers were captured.
- The manifest result names `parent_operation: "capture_browser_scenario"`,
  carries an empty `artifact` (`path: ""`, `sha256: null`) and states, as
  limitations, the ordinal rule, any dropped capture events and how many
  transactions retained no response body.
- `environment-serve` and `environment-export` authenticate either parent
  kind through the same loader, project scenario transactions through the same
  adapter, and keep the cross-check that the manifest's parent is the supplied
  Evidence. The bundle README names the capture kind and, for a scenario, the
  SHA-256 of the scenario definition in place of a capture artifact digest.

## Non-goals

- No new browser action: scenarios still cover what the UI requests plus GET
  reads through `goto`. A fetch or script action would be a new effect and
  needs its own scope decision.
- No change to what the scenario redacts. Values the application returns in
  response bodies are retained, as they are in HAR captures.
- The api-surface view keeps HAR parents only.
