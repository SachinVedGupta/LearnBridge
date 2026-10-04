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
4. Wait until the separate window reaches Avenue on
   `https://avenue.cllmcmaster.ca/d2l/`, then return to LearnBridge and choose
   **Check my school sign-in**. LearnBridge uses the browser-authenticated API
   request mechanism to read the actual school `whoami` response. Check the
   displayed account name. A landing page or completed Microsoft redirect alone
   does not establish that Avenue API authentication succeeded. If Avenue is
   open but LearnBridge still requires sign-in, refresh the school page in that
   separate window and check again. After expiry, complete any renewed sign-in
   and refresh Avenue; an old cached token is not reused. Authentication requires
   observing a normal authenticated school API request, not just a visible home
   page.
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
| Content outline | `le/{version}/{id}/content/toc` | Partial: module titles and topic references; only descriptions actually returned are retained; attachments and external links are not opened |

API versions come from the school's `/d2l/api/versions/` response. This
anonymous discovery route is not an authentication test. Supported versions are
sorted numerically, rather than lexically; obsolete LP versions below 1.49 are
rejected. Every selected read checks `whoami` before and after
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

The owned browser observes the school's normal API requests and captures only
valid `Authorization: Bearer` authentication for the exact Avenue API origin.
This passive observation accepts ordinary HTTP request methods so that school
bootstrap requests can establish authorization; it neither issues nor replays
those requests or reads their bodies. LearnBridge's own allowlisted reads remain
GET-only.
Both normal request events and correlated extra-header events are supported.
Their correlation is limited to 64 entries and a 15-second matching window;
expired entries are discarded before a new event can use them. Matching requires
the owned CDP session, current top-level frame and document loader, exact school
API URL and school document URL. Raw extra headers take precedence when available. Event ordering
cannot turn an unrelated or unmatched header into school authorization.
The transient bearer is reused only for fixed allowlisted school reads. This
matches Avenue MCP's browser sign-in and bearer-authorized API mechanism;
cookies alone are not treated as proof that those API reads are authenticated.
Each in-page read requires the exact institution origin and a `/d2l/` page
outside sign-in/logout routes, omits cookies, uses a request-specific
authorization header, and rejects redirects. No global
browser authorization header is installed.

The allowed browser commands are fixed implementation operations for owned
target creation/attachment, school authentication observation, and bounded
in-page reads. An HTTP request or MCP caller cannot select an arbitrary CDP
command or script. LearnBridge never reads `document.cookie`, cookie databases,
local storage, OAuth token endpoints or the student's usual Chrome profile.
Browser network-event metadata can traverse the private child pipe while the
student signs in. LearnBridge ignores request bodies, cookie headers, SSO
credentials and unrelated authentication metadata; those fields are not
persisted, logged or exposed to the API. Only bearer authorization on validated
requests from the current owned school document is consumed for this connection.
Credentials and tokens from unrelated sites or sign-in pages are not accepted
as school authorization.
The bearer remains transient local authentication state and is not a credential
input, a profile fact, a school snapshot or model context. A school 401, new
top-level document navigation, browser exit or disconnect clears it. Rotation replaces the previous
bearer and invalidates a read that began under the old authentication state.
LearnBridge does not assume a token remains valid for 23 hours or silently retry
a denied read with cached authorization.

No password, MFA, cookie or bearer token is accepted by the local/public API,
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
while connected. The bearer is held only in runtime memory for that owned
connection. Disconnect/logout/runtime close end the connection, erase transient
authentication state and remove the temporary profile. Neither the profile nor
the bearer is included in LearnBridge backups. Closing or crashing the owned
browser also clears transient authentication and removes its temporary profile.
A forcibly killed runtime may leave its temporary directory behind; no following launch adopts that directory or
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

The current suite passes 74 tests: 50 transport/authentication, 4 service/routes,
12 paired HTTP/SQLite and 8 UI handlers. The original cookie-only transport
was replaced after comparison with the pinned MCP authentication source. Transport fixtures start an actual
independent Node child over the same private file descriptors and execute the
shipped browser expression against invented responses. They cannot authenticate
to McMaster, bypass its policies or establish live institutional compatibility.

The [source-bound alignment receipt](D2L_AUTH_ALIGNMENT_VERIFICATION.json)
records code commit `5c4a31b`, all 827 app tests, both builds and nine clean
installation phases. It keeps the still-pending real school checks explicit.

The authentication-alignment regressions prove that cookie-only
requests cannot pass a bearer-required synthetic school, only owned
exact-origin API authorization is captured, both header event orderings obey
the bounded correlation, rotation discards stale in-flight reads, stale
authorization is not reused after expiry/navigation/disconnect, browser exit
cleans its profile, and no token appears in returned errors, school data
or persisted workspace records. These are synthetic regression obligations,
not a substitute for the live acceptance below.

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
`9f996323641aba91cc0bbf2b21efd429f9a465e1`; the public master revision was
rechecked during this authentication comparison. Its
[authentication implementation](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/auth.ts)
opens a local browser, follows school SSO, observes bearer authorization on
school API requests, and uses that bearer for subsequent API reads. LearnBridge
uses the same necessary authentication mechanism in independently written,
bounded code. It does not launch or vendor the upstream MCP server.

| Concern | Avenue MCP implementation | LearnBridge local connection |
| --- | --- | --- |
| McMaster sign-in | Configured Avenue login host, Microsoft SSO and school host | Fixed official McMaster split-host login and Avenue API origin |
| Password/MFA | Optional username/password environment variables and automated form entry | Student enters school credentials and completes MFA personally in the separate official window |
| API authentication | Captures bearer authorization from browser API requests, regardless of request method | Passively observes valid bearer authorization on ordinary HTTP requests from the current owned school target and exact Avenue API origin, then uses it only for allowlisted GET reads |
| Session retention | Persistent `~/.d2l-session` browser profile and a 23-hour token-cache assumption | Fresh temporary profile and connection-bound in-memory bearer; no adoption of the developer's saved MCP or normal Chrome session |
| API versions | Upstream API implementation chooses its own versions | Discovers versions from the school's current response and checks response contracts |
| Tool and data scope | Broader course, content and other MCP operations | Explicitly selected course metadata, assignment folders, announcements and outlines, followed by exact local review |
| Hosted website/phone | Upstream local process is a separate integration | School session and bearer stay on the student's laptop; no cloud/session forwarding |

The official [Brightspace API calling conventions](https://docs.valence.desire2learn.com/basic/apicall.html)
require the authorization token on API requests. A cookie-backed browser session
or a successful login redirect therefore cannot replace the authenticated
`whoami` and selected-course checks. These conventions informed the parity
correction; the institution still decides which calls the student may perform.
API shapes/version choices were checked against the October 2026 primary
reference for [API versions](https://docs.valence.desire2learn.com/res/apiprop.html),
[whoami](https://docs.valence.desire2learn.com/res/user.html),
[course offerings](https://docs.valence.desire2learn.com/res/course.html),
[assignment folders](https://docs.valence.desire2learn.com/res/dropbox.html) and
[content outlines](https://docs.valence.desire2learn.com/res/content.html).
The current table-of-contents contract does not promise module descriptions;
LearnBridge retains one only when it is actually returned.

[Chrome's remote-debugging guidance](https://developer.chrome.com/blog/remote-debugging-port)
requires a non-default profile for modern debugging connections. The private
pipe avoids publishing a debugging port and keeps login on the laptop. The
[DevTools protocol](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json)
provides the owned-target event and request boundaries; those boundaries do not
make arbitrary browser control available to LearnBridge's APIs or agents.

Institution-approved OAuth remains the route for public hosted D2L access;
see [D2L's first API application guide](https://docs.valence.desire2learn.com/basic/firstlist.html).
This local browser session is not forwarded to the public site or a phone
relay. Supporting additional schools, Windows/Linux, attachments, submissions,
grades or automatic background refreshing needs separate scoped implementation
and live acceptance; none is implied by this initial slice.
