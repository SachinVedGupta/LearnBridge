# Official public job discovery

## Student benefit and implemented workflow

The local **Public job discovery** screen can check a company’s official Greenhouse or global Lever public board, let the student select one posting, and retain the exact selected public source evidence alongside a reviewed local shortlist decision. This replaces a pasted-link-only discovery flow with an actual public-source check. It does not rank roles, establish eligibility, find every employer, fill an application, upload anything or submit it.

1. Choose **Greenhouse** or **Lever (global)** and enter the company board slug from its official careers link. A plain slug such as `company` is accepted; URLs, credentials, paths, arbitrary hosts and request options are not accepted.
2. Click **Search this public board**. Search persists only title/location/source-ID metadata with source observation times and response hashes. Opening or refreshing the screen reads local saved records and makes no provider request.
3. Click **Read this selected posting** for one metadata result. Only this explicit selected ID is fetched and its public description retained. The student can inspect both a readable text projection and the original selected provider fields.
4. Select a local shortlist state: `saved`, `investigating`, `preparing` or `dismissed`, optionally add a note, and save that exact reviewed decision. Rechecking does not overwrite the human decision.
5. Click **Check this official source again** when fresh evidence is needed. A failed check preserves the last selected content and successful response receipt while labeling it stale. A source 404 means unavailable at that official board, not that the role is globally closed.

Greenhouse’s ordinary list endpoint returns metadata without requesting its optional `content=true`. Lever’s public list API inherently returns additional description fields; this adapter receives that bounded public response but immediately discards those fields during metadata search. No description is retained or shown until the student explicitly selects its individual posting endpoint. This provider difference is disclosed in the screen and saved board limitations.

## Source and availability contract

Public observations are additive `career_item` records with format `learnbridge_public_jobs.v1` and categories `public_board` or `public_role`. Existing manual career/application records remain separate. Identity is derived from **provider + board slug + source ID**, never title. Same-title roles, another board’s role and Greenhouse/Lever IDs remain distinct; repeated reads update the same record.

Each selected successful observation retains:

- Provider, board, exact source ID, title, location and reported update time.
- The fixed official API URL, HTTP status, actual response byte count and SHA-256 of the fetched response bytes.
- Original selected public description fields, coverage/extraction labels, SHA-256 of the selected source projection and a separate SHA-256 of its displayed text.
- Source-observed time, last-attempt time/result and the previous source hashes when content changes.
- The exact reviewed local shortlist state/note, student identity, review time and source hash observed at review.

`availability` is `open`, `stale` or `unavailable_at_source`. `verified_opening` is true only after a compatible selected current API response, within the 24-hour freshness window, with no later contradictory board metadata and no passed provider-reported application deadline. This verifies published-source presence, **not student eligibility, suitability, work authorization or interpretation**. A complete later board check that omits the ID marks its old selected content stale until individually rechecked; it does not close it. A partial board check retains earlier metadata not returned in its successful new pages, including each entry’s original observation time/hash; the UI visibly labels incomplete/retained metadata. Failed board checks retain earlier metadata. Failed or partial coverage never becomes an empty-success claim.

The overview omits selected source bodies. Opening saved detail reads the already selected local body. The source projection is intentionally bounded: Greenhouse content has common entities decoded and HTML tags projected into inert text; Lever uses provider plaintext plus a bounded list projection. Original selected fields remain inspectable. This is not a browser rendering or a complete HTML/text-extraction guarantee. Source text, including embedded instructions, never becomes executable HTML, a model prompt, a filesystem request or an application action.

## Request, persistence and authority limits

Only fixed HTTPS GET API endpoints are constructed:

```text
https://boards-api.greenhouse.io/v1/boards/:slug/jobs
https://boards-api.greenhouse.io/v1/boards/:slug/jobs/:numericId
https://api.lever.co/v0/postings/:slug?mode=json&skip=:offset&limit=50
https://api.lever.co/v0/postings/:slug/:uuid
```

Redirects and changed final URLs are denied. Provider-supplied posting/application URLs are not fetched; source links are generated from the validated provider/slug/ID. Requests use no credentials or cookies, accept JSON, forbid redirects, and have owned cancellation. HTTP errors and schema changes become stable redacted error codes; raw provider errors are not logged or saved.

Limits are explicit: 600,000 response bytes per request, 80,000 selected content bytes, 100,000 combined selected snapshot bytes, 110,000 retained metadata bytes, 120,000 persisted record bytes, 10 seconds per request, at most three Lever pages of 50 metadata rows, at most 500 saved metadata entries per board, 20 boards and 200 selected roles. The byte limits can stop before the count limits and remain below the existing store’s per-record budget. An over-budget merged partial observation preserves the prior metadata and records a failed budget check instead of silently dropping old rows. A full third Lever page is labeled partial because additional pages were not checked. One network discovery operation runs at a time. Actual streaming bytes are bounded even when Content-Length is absent. Runtime shutdown aborts owned requests. Authorization is rechecked after awaited responses and before persistence; logout/revocation prevents saving late source observations. Concurrent shortlist changes cause a revision conflict instead of a stale network result overwriting the human decision.

The normal local runtime’s paired cookie, nonce, same-origin, strict body and no-query boundaries protect these routes:

| Method and route | Exact input / result |
| --- | --- |
| `GET /api/local/v1/public-jobs/state` | Metadata overview, saved-role summaries and capabilities |
| `POST /api/local/v1/public-jobs/search` | `{ provider, board_slug }` → `{ board }` |
| `POST /api/local/v1/public-jobs/read` | `{ provider, board_slug, job_id }` → `{ role }` |
| `GET /api/local/v1/public-jobs/roles/:recordId` | Selected saved local detail → `{ role }` |
| `POST /api/local/v1/public-jobs/roles/:recordId/shortlist` | `{ expected_revision, state, note? }` → `{ role }` |

No API keys, account connections, application POSTs, background scans, cloud writes, browser automation, model sharing, new production dependencies or authentication/provider configuration are introduced.

## Verification completed

```sh
cd web
node --test scripts/public-job-*.test.mjs
node --test scripts/public-job-*.test.mjs scripts/local-career*.test.mjs scripts/local-productivity*.test.mjs
```

All **21 new tests** and all **58 combined discovery/career/productivity tests** pass. The new tests use an independently authored provider fixture and real runtime HTTP/SQLite storage to verify fixed GET requests, metadata/body selection, SHA-256 pins, IDs/board separation, repeated pages, partial/failed preservation, 404 recovery, freshness/deadline transitions, source changes, byte/page/input boundaries, redirects/schema drift, strict authority before fetch, logout during await, owned shutdown, revision conflicts, restart and a fresh verified backup restore. The actual shipped UI module is executed against actual HTTP with a synthetic DOM to verify explicit click behavior, zero opening/refresh scans, source display, review decisions and late-result suppression. Those controller tests do not claim an actual browser downloaded, rendered or interacted with a live employer page.

An actual unauthenticated public Greenhouse read was also completed in an isolated temporary workspace on **2026-10-05 at 01:27 UTC (October 4 locally)**:

- Board `greenhouse`: 18 metadata rows, complete response, 11,271 bytes, response SHA-256 `8735a482e0fc750328fc479ec906d26668aa4cd0cc7f171c1b945fee7065fed6`.
- Explicitly selected ID `8129288`, **Manager, Security Engineering**, location **British Columbia**: 11,882 response bytes, response SHA-256 `f5170be2efd4cd0070b129ffc681d713b7a32139cb522ac4a1d191ed6bbd9269`.
- Selected source SHA-256 `dfafd43e02658e40e3f25a204fbe5d9472f38ed76637c7a054a930ef4172ffdb`; extracted-text SHA-256 `7e81575685ca760af7c4b9fad1d678b9f38c0641de1909428891d22b9911a8b1`.
- A second independent GET of the exact selected API URL confirmed its ID/title/location and raw response hash. The disposable workspace was removed. No credentials or external writes were used.

This manager role was an adapter verification fixture, **not a suggested internship or a suitability claim**. Availability is observed at the stated time and may change. Live Lever compatibility and the actual full browser search/read/review layout remain distinct verification gates; fixture correctness does not prove every employer’s board schema.

## Next feasible work

1. Add reviewed application packets that pin a current selected role, purpose-appropriate confirmed profile sources and already accepted writing drafts; report missing facts without inventing them.
2. Add selected official Greenhouse application-question metadata through the same explicit bounded read contract, if a dedicated question/schema adapter and retention review are implemented. No application POST follows from reading questions.
3. Add student-entered search filters over saved metadata and deterministic shortlist organization. Provider-wide employer discovery/ranking, private/internal boards, Lever EU endpoints, ATS form preparation and employer-browser compatibility remain separate adapters with their own objective checks.

## Primary provider documentation

The API contract follows the official [Greenhouse Job Board API documentation](https://docs.greenhouse.io/job-board.html) and the official [Lever Postings API repository](https://github.com/lever/postings-api). Both document public GET retrieval. Their application-submission capabilities are intentionally outside this feature’s contract.
