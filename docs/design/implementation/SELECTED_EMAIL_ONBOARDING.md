# Selected Gmail onboarding

This workflow brings explicitly selected Gmail plaintext into a student's private local workspace. It uses the existing Supabase identity and configured Composio Gmail account. It creates no model request, mail write, task, profile fact, recurring sync or sharing grant. It adds no dependency, migration, OAuth scope or provider configuration.

The source service and UI are implemented and covered by synthetic provider tests, actual hosted handler/SDK boundary tests, shipped browser event handlers and actual paired local HTTP imports. The two real pinned tool schemas were checked without listing connected accounts or reading messages. A live student-owned selected-message read remains unverified; schema compatibility does not establish account permission or mail access. Deployment is a separate release action.

## Student workflow

1. Sign into LearnBridge and open `/onboarding/email`. Connect your own Gmail account through Connections if needed. The page lists eligible connection metadata but selects no account, folder, date or message automatically.
2. Choose one account, Inbox/Sent/Starred, at most 90 UTC calendar days and a nonempty subject phrase. Choose **Search selected email metadata**. This explicit action requests one page of at most 20 matches. It never follows pagination and claims only partial coverage. Quotation marks, backslashes, newlines, colons and search operators are not accepted as phrase syntax.
3. Review subject, sender/recipient assertions, exact message ID and the source-reported timestamp. All checkboxes start unchecked. Choose up to three messages, select an academic policy and choose **Read only checked messages**.
4. Review all returned plaintext, private addresses, source IDs, selected scope, timestamps, policy, hashes and limitations. Check the full review box, choose **Download reviewed email bundle**, then confirm the separate labelled private-download panel. The browser verifies the entire canonical bundle and every text hash before preparing a compact JSON file. File preparation does not prove a saved download.
5. In the paired local dashboard open **Cloud sources**, choose that one file and preview it. Review again, confirm that the exported account is yours, then confirm the exact local import. The existing importer creates private notes, checks their exact content/pins and returns a source receipt. The portable owner identity is an assertion needing student confirmation, not authentication to a Gmail account on the laptop.
6. Use the notes in Learning, Writing or other local workflows. If a host needs their content, select the notes and separately approve the existing bounded sharing grant. Import alone grants no model access. The source note contains the private email provenance shown during review, so inspect the exact selected note before any later sharing.

Changing any account, folder, date, subject, selected message or policy clears the current preview and download confirmation. Withdrawing review, expiry or unmounting stops pending export/hash work from creating a late file. HTML is never rendered from message content; text, addresses and titles remain literal escaped data.

## Acquisition and ownership

The hosted operation derives its student UUID only from `requireUser()`. Account metadata queries use `userIds:[verifiedStudent]`, toolkit `gmail`, `accountType:PRIVATE`, status ACTIVE and a limit of 100. Eligible accounts must match the app's current `COMPOSIO_AUTH_GMAIL`, remain enabled and be returned under that authenticated owner filter. There is no developer-account, desktop-session or public-account fallback. Raw provider account `state`, `data`, `params` and credentials are not forwarded.

Before and after schema checks or selected reads, the service checks the current eligible account again. The route rechecks the signed-in identity after reading its bounded request body and after acquisition. Changed identity, revoked account, cancellation, unexpected returned ID, changed selected metadata or changed folder membership prevents a reviewed bundle. Provider exceptions become static guidance; their raw contents are not returned.

The existing official Composio SDK disables SDK tracking and executes only two fixed versioned read tools with tracing disabled, exact verified `userId`, selected `connectedAccountId` and a cancellation signal. Browser input cannot name a provider, raw tool/RPC, `user_id`, attachment, thread, cursor, destination or alternate owner.

| Tool | Version | Fixed use |
| --- | --- | --- |
| `GMAIL_FETCH_EMAILS` | `20260915_00` | `user_id:'me'`, one chosen `label_ids`, `max_results:20`, `verbose:false`, `ids_only:false`, `include_payload:false`, `include_spam_trash:false`. |
| `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `20260915_00` | `user_id:'me'`, one sealed selected `message_id`, `format:'full'`. |

The search query uses epoch-second UTC boundaries and one quoted literal `subject` phrase. Its lower `after` boundary and upper `before` boundary are exclusive; the upper boundary is midnight following the chosen end date. These filters and the first-page cap do not prove complete date-window coverage. No arbitrary Gmail query syntax is passed from the browser. The selected folder is enforced both in the fixed search arguments and returned message-label membership.

The tool schemas are checked for exact slug/version and required input-field names before acquisition. This is a compatibility check, not a promise that the connection has adequate scopes. In particular, `gmail.metadata` alone cannot read a full selected body; this workflow requires an existing compatible read permission. [Google's response formats](https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format) explicitly restrict `full` under that scope. Missing permission is an explicit provider failure. It does not broaden scopes or reconnect automatically.

## Metadata and MIME limits

The search asks Composio for metadata. Its declared output schema can nevertheless include body, preview or attachment fields. LearnBridge drops those recognized fields and reports their **serialized UTF-8 byte count** as `unexpected_content_bytes`; it does not claim unexpected fields were never received by the server. Browser metadata and selection seals contain only message ID, thread ID, subject, sender, recipient and source timestamp. Provider cursors, snippets, raw payloads and attachment names are not returned or exported.

An exact selected `full` read may receive complete MIME structure and extra inline bytes. LearnBridge decodes only inline `text/plain` parts with UTF-8 or ASCII encoding, validates canonical base64url and joins supported parts in returned order. Parts with filenames or attachment IDs, embedded emails, HTML, and unsupported encodings are omitted or refused. It does not call an attachment/thread tool, fetch referenced URLs, execute instructions or convert HTML into a browser document. HTML-only messages and other encodings need a separately selected manual excerpt.

| Boundary | Limit |
| --- | --- |
| Eligible account response | 100; an additional cursor means partial metadata coverage. |
| Search scope | One supported folder, 1–90 UTC days, subject phrase at most 200 UTF-8 bytes. |
| Search response | First 20 matches, at most 200,000 serialized bytes before projection; no cursor following. |
| Selected read | 1–3 unique sealed messages from the same account and exact search scope. |
| Full MIME response | At most 100,000 serialized bytes; bounded structural validation. |
| MIME traversal | 100 parts, depth 8; no attachment or embedded-email traversal. |
| Exported plaintext | 20,000 UTF-8 bytes per message; overflow fails rather than silently truncating. |
| Complete transfer | 90,000 compact JSON bytes including hashes. |
| POST body | Probe/search 4,096 bytes; preview 20,000; export 180,000, counted from the actual stream. |
| Selection/review lifetime | Five minutes; owner/account/scope/exact content seals. |
| Hosted/browser operation | 25/30-second cancellation signals. |

Selected email is a partial text snapshot. MIME conversion, original visuals, upstream revision, live freshness and completeness remain unverified. A `Date` header is a sender-reported assertion. The generic provider `messageTimestamp` is preserved exactly with unspecified semantics, rather than relabelled as sent, received or modified time.

## API and additive transfer contract

All responses are private and uncached. POST additionally requires the configured origin, normal Supabase authentication and the existing connector quota. Unknown actions/query parameters are refused.

| Endpoint | Input | Result |
| --- | --- | --- |
| `GET /api/email-onboarding/accounts` | None | Eligible owned Gmail metadata; no message search. |
| `POST .../probe` | `{account_id}` | Compatible pinned tool schema; `personal_content_read:false`. |
| `POST .../search` | `{account_id,scope:{folder,start_date,end_date,subject_phrase}}` | Body-free metadata, exact opaque selection tokens, partial coverage and unexpected-content byte disclosure. |
| `POST .../preview` | `{account_id,selection_tokens,academic_policy}` | Exact Gmail v2 bundle, review hash, sealed preview, expiry and `sharing:not_granted`. |
| `POST .../export` | `{preview_token,review_hash,confirm:true}` | The same reviewed bundle and fixed `LearnBridge-selected-gmail.json` filename after fresh account checks; no new content read. |

The service seals selections and bundles with a domain-separated HMAC key derived from the existing server-only Composio key. Seals bind verified owner, account, exact resource/scope or complete bundle, random nonce and expiry. They reject cross-student, forged, duplicate, mixed-account, mixed-scope or expired selections. Portable files contain no seal, secret, credential or model destination. A repeated valid export prepares the same read-only bundle after a fresh account check; it performs no email write.

The existing `learnbridge-selected-cloud-export` transfer gains **version 2 only for Gmail**. Docs/Notion version 1 validation, hashes and imported text remain unchanged. The existing Docs/Notion acquisition provider list is not widened.

Gmail uses the same owner, origin, account, retrieval time, academic policy, record text hashes and canonical bundle hash. Each record has `url:null`, `modified_at:null` and adds the following exact private provenance:

```js
source_metadata: {
  kind: 'email', message_id: '19b11732c1b578f0',
  thread_id: '19b11732c1b57000',
  from: 'provider-returned sender or null',
  to: 'provider-returned recipient or null',
  date_header: 'exact returned Date header or null',
  sent_at: null, // canonical time only when the Date header parses
  received_at: null, // not provided with authoritative semantics here
  provider_timestamp: 'exact reported messageTimestamp or null',
  timestamp_semantics: 'provider_reported_unverified',
  selected_scope: { folder: 'INBOX', start_date: '2026-09-01',
    end_date: '2026-09-30', subject_phrase: 'Lecture' }
}
```

Unknown provenance/authority fields and invented received timestamps are refused. A normalized sent time must agree with its exact Date header. Gmail message/thread IDs are bounded lowercase hexadecimal provider IDs. Sender/recipient assertions are preserved in the private note and receipt for student review; they create no confirmed profile facts. Body-free receipt listing includes that explicitly reviewed metadata but omits message text. The local importer keeps policy tightening, exact ownership review, revision checks, idempotent retained retries, reconciliation, restart and fresh-backup restore. Removing a receipt retains separate notes, downloads, history, backups and any separately approved sharing choices.

## Objective verification and remaining gate

Run `node --test scripts/email-onboarding-*.test.mjs` inside `web`. These tests use synthetic accounts/messages and the actual service, hosted route closures, SDK adapter, private SQLite, paired HTTP and shipped UI event handlers. They prove bounded source choices, owner/scope seals, unchanged v1 behavior, literal malicious content, no external write/attachment/model calls, cancellation/replay handling, exact reviewed Blob bytes, separate local owner confirmation, pin readback and restart/restore. Browser event fixtures prove preparation and control flow; they do not establish browser layout, saved downloads or real provider access.

The remaining live gate is one student-selected account/folder/date/subject search, one explicitly checked plain-text message, full preview, exact reviewed download and local import/readback. Confirm wrong-account denial with a second student account. Verify scopes without changing them, keep unmatched sources unselected and do not infer complete mailbox coverage. Do not use private account contents as an installation fixture.

Primary references: [Composio Gmail toolkit](https://docs.composio.dev/toolkits/gmail), [Gmail fetch guidance](https://docs.composio.dev/kb/guide/toolkits-gmail), [Google message fields and MIME structure](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [Google Gmail search/date filtering](https://developers.google.com/workspace/gmail/api/guides/filtering). Schema-only evidence and test counts are in `SELECTED_EMAIL_VERIFICATION.json`.
