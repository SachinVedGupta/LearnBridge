# Local Avenue / D2L connection

Implemented 2026-10-04. This is a foreground, student-controlled McMaster
Avenue connection for the local LearnBridge website. It prepares selected
school facts for the existing exact academic review and refresh workflow. The
implementation does not claim that a real student account or every institution
has been verified by the synthetic test suite.

## Student setup

1. Set up and launch LearnBridge locally, then pair the local dashboard.
2. Open **Avenue / D2L** and choose **Open official Avenue sign-in**.
   LearnBridge opens visible Google Chrome with a fresh, separate profile.
3. Personally complete the official McMaster sign-in and MFA in that window.
   Enter neither a school password nor a token into LearnBridge or a chat.
4. Return to LearnBridge and choose **Check my school sign-in**. LearnBridge
   reads the actual school `whoami` response. Check the displayed account name.
5. Find the numeric course ID in its Avenue URL, for example
   `/d2l/home/781264`. Enter one to five course IDs. Select assignment folders,
   announcements, content outlines, or a combination. All choices start empty.
6. Choose **Read only my selected courses**. Inspect the exact returned facts,
   deadlines, coverage, policy, changed items and missing items. This read saves
   no course records, tasks or sharing grants.
7. Check the explicit review box and choose **Save reviewed course changes**.
   Confirm the local save. Open **Courses** for the reviewed current snapshot.
   Agent access remains a separate, selected and reviewed sharing step.
8. Choose **Disconnect school browser** when finished. LearnBridge terminates
   only its owned browser process group and removes its temporary profile.
   Disconnect, local logout and runtime shutdown also end this school session.
   Reviewed local snapshots, revisions and backups follow their normal retention.

The first implementation requires the normal Google Chrome application on
macOS at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
Unsupported platforms retain the existing reviewed-export workflow. There is
no silent fallback to someone else's browser profile or an arbitrary executable.

## What the connection can read

| Selected information | Exact source | Coverage and limitation |
| --- | --- | --- |
| School identity | `lp/{version}/users/whoami` | Actual current browser account; no identity inference from a local label |
| Selected course metadata | `lp/{version}/courses/{id}` | Only supplied course IDs; no enrollment inventory |
| Assignment folders | `le/{version}/{id}/dropbox/folders/` | Partial: quizzes, discussions, calendar events and submissions are excluded |
| Announcements | `le/{version}/{id}/news/` | Returned collection; explicit errors lower coverage |
| Content outline | `le/{version}/{id}/content/toc` | Partial: module descriptions and topic references; attachments and external links are not opened |

API versions come from the school's `/d2l/api/versions/` response. Supported
versions are sorted numerically, rather than lexically; obsolete LP versions
below 1.49 are rejected. Every selected read checks `whoami` before and after
acquisition. A changed account locks the connection until disconnect; checking
again does not silently rebind an old review to a different account.

Source timestamps retain their returned precision and offset through the
existing academic normalizer. Root-relative topic links become institution
references, with no follow-up network read. HTML is literal source text,
rendered through text nodes, never inserted as active markup. Missing items
remain evidence of incomplete observation; they do not delete student tasks.

## Browser and credential boundary

`d2l-browser.mjs` starts a fixed official Chrome binary using
`--remote-debugging-pipe`. Commands and results travel through private child
file descriptors 3 and 4. There is no TCP debugging port or externally
reachable CDP/WebSocket endpoint. A fresh 0700 profile is created in the OS
temporary directory, outside the workspace and its database backups. Browser
environment variables are restricted to basic home, locale and temporary-path
settings; application API keys, proxy settings and Node injection options are
not inherited.

Only target creation, target attachment and one fixed browser-side GET
expression are available. The expression requires the exact institution
origin and a `/d2l/` page. The browser sends its own same-origin session cookies
using ordinary credentialed GET behavior. LearnBridge never reads
`document.cookie`, cookie databases, local storage, network Authorization
headers, OAuth token endpoints or the student's usual Chrome profile. No
password, MFA, cookie or bearer token is accepted by the local/public API,
stored in the LearnBridge database, passed to a model or copied into a cloud
connection. School browser control is absent from agent IPC/MCP tools.

The GET allowlist rejects queries, arbitrary URLs, grades, submissions,
enrollment scans, file downloads and every write operation before issuing a
browser command. School 401/403, redirected responses, HTML login pages,
invalid JSON, oversized responses and transport failures fail closed. A
denied category is reported as partial coverage; an expired identity cannot
produce a successful new review. No blocked school access is bypassed.

The account reference is an institution-qualified SHA-256-derived identifier.
The transient status returns a display name for student review, without email,
username, raw `whoami` fields or credentials. Identity is not automatically
added to a confirmed profile. `/status` exposes only transport readiness,
without school account details.

The temporary Chrome profile contains the browser's own active school session
while connected. It is removed on disconnect/logout/runtime close and is not
included in LearnBridge backups. A forcibly killed runtime may leave its
temporary directory behind; no following launch adopts that directory or
recovers its session. The student must sign in again for each fresh connection.

## API and service contract

All `/api/local/v1/d2l/*` routes require the existing loopback pairing, session
cookie and exact nonce. Mutations also require the exact local Origin.
Bodies have exact allowed/required keys and a 4096-byte cap. Query strings are
rejected. A connection and retained previews belong to the pairing nonce that
started them; another paired browser sees no school account and cannot control
or save them.

| Route | Method and exact body | Result |
| --- | --- | --- |
| `/d2l/status` | GET | Institution, transport capability, owned transient connection or null, selection limits and notice; no school read |
| `/d2l/start` | POST `{institution_id:"mcmaster-avenue"}` | 201: transient connection awaiting student sign-in; does not infer successful authentication |
| `/d2l/verify` | POST `{connection_id}` | 200: actual school account and verification timestamp, or denied/expired state |
| `/d2l/preview` | POST `{connection_id,selected_course_ids,categories}` | 200: retained preview ID, exact normalized snapshot, refresh comparison/hash, scope, limitations and proof |
| `/d2l/import` | POST `{preview_id,review_hash}` | 201: existing atomic academic refresh receipt; no new school read |
| `/d2l/disconnect` | POST `{connection_id}` | 200: owned process/profile cleanup and retention notice |

Selection IDs are one to five distinct positive safe numeric **strings**;
categories are a nonempty distinct subset of `assignments`, `announcements`,
`materials`. The service canonicalizes scope and rejects unknown categories.
Unselected categories remain `unknown`, not empty-and-complete.

`createD2lService({studentWorkspace,browserFactory?,clock?})` exports
`status()`, `start(body)`, `verify(body)`, `preview(body)`,
`save(retainedPreview,{review_hash,idempotency_key})`, `disconnect(body)` and
`close()`. `createD2lRoutes(...)` exports `handle(...)`, `capability()` and
asynchronous `clear()`. Root server wiring awaits clear on logout/shutdown and
rechecks local authorization after asynchronous route work. Browser launch,
verification and selected acquisition are mutually exclusive. Generation
checks prevent late work from resurrecting ownership after disconnect/clear.

Browser factory and clock injection are trusted code/test seams. They cannot
be selected through an HTTP body, environment-provided executable, CLI launch
option or student credential form. The default browser transport reports
`live` proof only after actual selected browser reads return. Injected
transport reports `fixture`; startup and identity verification alone retain
`none` as the selected-read proof. The UI labels synthetic results explicitly.

School authentication errors become HTTP 409 `D2L_AUTH_REQUIRED` or
`D2L_AUTH_EXPIRED`, preserving the independent local pairing. Local pairing
authentication errors continue to use the normal 401 behavior.

## Review, storage and budgets

Previews remain in memory for five minutes and are limited to ten outstanding
reviews. Saving uses the server-retained value, exact review hash, current
academic head revision and a preview-specific idempotency key. Client-supplied
snapshot replacement is rejected. A superseded unsaved preview cannot write
an old course head. Exact save retries within the retained review lifetime
return the existing atomic receipt. Consumed reviews are reclaimed before a
new preview, so old retry IDs may stop being available after that reclamation.

The service writes only through `commitAcademicRefresh`. It adds no schema,
database kind, source grant, task, note, confirmed profile or automatic host
context. Normal academic snapshots, observations, immutable history and source
hashes remain the evidence for later course retrieval. Restart/backup restore
retain reviewed facts, never transient connection ownership or pending reviews.

The transport bounds response JSON to 256000 bytes, CDP framing to 1000000
bytes, outstanding commands to four, each browser command to 15 seconds, and
browser-side fetches to 10 seconds. One acquisition is at most five explicitly
selected courses and three selected category reads per course, plus identity
checks. Combined returned course/category JSON is capped at 256000 bytes.
Strict cloning rejects accessors, inherited objects, symbols, executable
values, sparse arrays, cycles, excessive depth/nodes and oversized input. The
existing academic normalizer and storage retain their own smaller budgets;
reduce selected courses/categories if those bounds are reached. No automatic
pagination, background refresh or retry expands the scope.

## Objective verification

Run from the repository root:

```sh
node --test --test-concurrency=1 \
  web/scripts/local-d2l-browser.test.mjs \
  web/scripts/local-d2l-service.test.mjs \
  web/scripts/local-d2l-http.test.mjs \
  web/scripts/local-d2l-ui.test.mjs
```

The initial shipped suite contains 36 tests: 12 transport, 4 service/routes,
12 paired HTTP/SQLite and 8 UI handlers. Transport fixtures start an actual
independent Node child over the same private file descriptors and execute the
shipped browser expression against invented responses. They cannot authenticate
to McMaster, bypass its policies or establish live institutional compatibility.

The suite checks exact permitted requests, no secret environment inheritance,
profile permissions/cleanup, redirects and denied/expired responses, timeout,
cancellation, malformed frames, numeric version choice, strict inputs,
account-change lock, separate nonce ownership, partial/unrequested coverage,
exact deadlines and literal HTML, review/hash/head checks, bounded preview
pressure, logout during launch/verification/acquisition, preserved manual work,
zero incidental grants and exact reviewed readback after restart and a real
independently restored backup. UI cases cover default empty selections,
explicit review and confirmation, changed scope, reset during pending actions,
late status supersession and busy-state cleanup.

Live acceptance still requires a student to personally finish school SSO/MFA,
verify their actual account, read explicitly selected courses, review coverage
and dates against Avenue, save and read back the exact local snapshot, and
disconnect with the owned profile removed. An open school tab or successful
synthetic fixture is not this acceptance result. A real school denial remains
a limitation; use a reviewed export or seek institution-approved OAuth access.

## Primary sources and implementation choice

Reviewed [alanxue1/avenue-mcp](https://github.com/alanxue1/avenue-mcp) at commit
`9f996323641aba91cc0bbf2b21efd429f9a465e1`. Its local browser approach informed
the feasibility review. Its password automation, extracted bearer-token/session
handling, broad tool surface and HTTP behavior are not launched or vendored by
LearnBridge. This implementation uses an independently written bounded path.

The official [Brightspace fetch-auth implementation](https://github.com/Brightspace/d2l-fetch-auth/blob/b8f2f1f31e8b4bc57877f03c5103c50e402b12d2/src/unframed/d2lfetch-auth.js)
supports same-origin cookie-backed GET behavior. This informed the fixed
in-page read; it does not guarantee every institution permits every API call.
The school itself still decides access. API shapes/version choices were checked
against the October 2026 primary documentation for
[API versions](https://docs.valence.desire2learn.com/res/apiprop.html),
[whoami](https://docs.valence.desire2learn.com/res/user.html) and
[course offerings](https://docs.valence.desire2learn.com/res/course.html).
[Chrome's remote-debugging guidance](https://developer.chrome.com/blog/remote-debugging-port)
also requires a non-default profile for modern debugging connections. The
private pipe avoids publishing a debugging port and keeps login on the laptop.

Institution-approved OAuth remains the route for public hosted D2L access;
see [D2L's first API application guide](https://docs.valence.desire2learn.com/basic/firstlist.html).
This local browser session is not forwarded to the public site or a phone
relay. Supporting additional schools, Windows/Linux, attachments, submissions,
grades or automatic background refreshing needs separate scoped implementation
and live acceptance; none is implied by this initial slice.
