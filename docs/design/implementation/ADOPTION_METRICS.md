# Optional adoption measurement implementation

This slice implements the early first-party F29 boundary. **Collection is disabled by default. No production configuration, migration, admin enrollment, collection request or deployment was performed.** No historical adoption counts are available from this work.

## What is measured

| Field | Meaning |
| --- | --- |
| `observed_page_views` | Opted-in observations of the public setup page, not visitor/person counts. |
| `successful_prompt_copies` | Distinct accepted events emitted only after the browser clipboard promise resolves. Retry of one event ID is deduplicated within raw retention. Manual copies are unmeasured. |
| `failed_copy_observations` | Optional observed clipboard failures; never added to successful copies. |
| `opted_in_setup_account_enrollments` | Current explicitly opted-in verified Supabase accounts whose enrollment was created in the range. This is neither new-account creation nor local installation. An existing account can enroll. |
| `hosted_save_operations` | Once-per-current-revision successful task/draft state saves, with independently verified own database state and a five-minute freshness check. Polling/sign-in/doctor is not included. |
| `active_opted_in_hosted_accounts` | Distinct raw account activity IDs in a window wholly within the last 30 UTC days. Older windows return unavailable because raw identities expire; daily account totals are not summed into monthly unique accounts. |

`visitor_estimate`, `setup_accounts_created`, `local_activation_enrollments` and `opt_in_weekly_active_installations` are **null/unavailable**, not zero or derived from clicks. Later local reporting still needs separate local consent, enrollment, a versioned actual verification predicate, weekly rotation, queue/retry/erase rules and a consenting live pilot. This slice sends no local telemetry and does not enroll it through setup/doctor/agent registration or relay.

Client observations can be forged. Origin checks are not bot authentication. No joins between anonymous events and authenticated accounts are implemented. Any comparison of copies/accounts is an aggregate directional ratio. Neither constitutes a count of unique people, installations, mastery or product quality.

## Fields, bounds and retention

An anonymous request has one bounded event and an explicit reviewed consent envelope:

```json
{
  "consent": { "state": "opted_in", "version": "public-setup-metrics-1" },
  "event": {
    "schema_version": 1,
    "event_id": "55555555-5555-4555-8555-555555555555",
    "event_name": "setup_prompt_copy_succeeded",
    "route": "/setup",
    "prompt_version": "local-setup-1-2026-10-03"
  }
}
```

Allowed event names are `setup_page_view`, `setup_prompt_copy_succeeded` and `setup_prompt_copy_failed`. Unknown properties, other routes/versions, raw URLs/referrers, names/emails, account/device IDs, prompts, files, source metadata, tokens and client timestamps are rejected. No persistent anonymous visitor or installation ID exists. UUIDs identify individual observations only. The client sends without credentials/referrer and uses a fixed same-origin endpoint. Application errors contain stable codes; no rejected body or raw database diagnostic is logged by this code. Hosting/network services still process ordinary request metadata under their own policies; this schema cannot erase infrastructure logs.

Request body is streamed and capped at 2,048 UTF-8 bytes with a fixed two-second read deadline. An intentionally conservative per-process bucket accepts at most ten requests per minute for all anonymous callers together; it keeps no IP or visitor key. PostgreSQL separately locks transactional ingestion and caps accepted global public events at 120 per rolling minute and 10,000 retained raw events. Account activity and enrollment tables have independent 10,000-record caps. Database quota/rate drops appear in aggregate coverage. Browser/offline/process-limiter losses remain unknown coverage and can undercount.

The opted-in browser holds at most 20 unsent observations in the current page session, with at most three attempts per observation. There is no persistent storage, timer-based background retry or enrollment credential. Opt-out purges the queue, aborts the pending request and prevents further sends. A request already received by the server cannot be recalled by toggling this local choice. Raw anonymous events and account activity are retained for at most 30 days **only after the required scheduled retention job is configured and verified**; anonymous daily aggregates remain at most twelve months. Event deduplication lasts thirty days; an old event replay after its raw record expires cannot be guaranteed unique.

Account consent settings are private operational state until changed/account deletion. Turning account reporting off immediately removes raw own activity and directory access; anonymized aggregate operation totals can remain. A separate explicit directory choice permits authorized admins to view confirmed email and provider/user-supplied display name; names are not verified legal identity. No marketing consent is implied. Directory output is capped at 100 currently opted-in accounts and does not claim complete pagination.

## Integration hooks and default flag

Environment contract:

```text
LEARNBRIDGE_ADOPTION_ENABLED=0
```

Unset or any value other than exactly `1` is disabled. Do not enable this flag before the live SQL/RLS, retention and browser gates below. Existing `APP_URL`, public Supabase URL/publishable key and normal verified Supabase authentication are used; normal collector routes never use a service-role key. No new dependency is added.

Optional public setup wiring, owned by the parent integration:

1. Wrap the existing `SetupPrompt` in the new client `SetupMeasurement` provider, passing the server-controlled feature flag as its `enabled` prop. Default is `false`.
2. In `SetupPrompt`, call `useSetupMeasurement()` and pass `() => { measurement.observeCopySucceeded(); }` only as `copyPrompt`'s existing post-success observer. Do not count a button click, unresolved promise or manual selection as copy success. Optional failure diagnostics remain separate.
3. Render `AccountMeasurement` separately with the same feature flag. It does not read auth/account state until the student explicitly opens those settings. Remove/update the older unconditional “measurement off” line only if these feature-aware notices are actually wired.
4. After a successful hosted own state save, schedule `after(() => recordHostedStateSave(db, kind, data.revision))` from the authoritative server success path. The helper is off by default and failures return false without blocking the save. Do not instrument request attempts, polls or sign-ins. SQL rechecks the exact current own saved revision independently, under the same lock used for consent changes so an in-flight activity cannot reappear after opt-out.

The parent has wired these four hooks in the working tree with the server feature flag still disabled by default. No production collection is implied by the code integration.

New endpoints:

| Endpoint | Boundary |
| --- | --- |
| `POST /api/adoption/events` | Expected origin/content type, fixed route/no query, strict schema, page-session opt-in, anonymous narrow RPC, limits. No table reads or account cookies. |
| `GET/PUT /api/adoption/enrollment` | Verified confirmed Supabase account, own `auth.uid()` settings, account-bound review hash and revision CAS; no caller-supplied user/name/email selector. Counts and directory are separate choices. |
| `GET /api/admin/adoption?start=YYYY-MM-DD&end=YYYY-MM-DD` | Verified server user plus private database admin membership, maximum 366 inclusive UTC days. Aggregates only. |
| `GET /api/admin/adoption/directory` | Same verified admin gate, only currently selected directory accounts, no anonymous IDs. |
| `POST /api/admin/adoption/purge` | Same verified admin and origin gate, empty exact JSON body, fixed retention only. |

The existing proxy leaves these API endpoints to their own explicit gates. Admin status is checked by `adoption_is_admin()` against a private `adoption_admins` table, then again inside every privileged RPC. A hidden route, browser flag, user metadata or caller-supplied ID cannot grant admin. Raw event/identity tables have RLS enabled and no anon/authenticated SELECT/UPDATE/DELETE policy or table grants. Only typed narrow functions are executable. Anonymous direct RPC still cannot forge arbitrary properties or bypass database quotas, but it can forge allowed event observations; counts remain labeled accordingly.

Opening account settings returns only whitelisted consent fields and a SHA-256 review hash bound to the verified account and current settings. A save includes `expected_revision`, `expected_review_hash`, `enabled`, `directory_enabled` and the consent version. The server reads current own settings again, validates the review and verifies the exact saved flags/revision. A stale form after switching accounts is rejected even when both accounts have the same numeric revision. This private review hash is not an authentication credential and is never added to anonymous telemetry. An uncertain save requires loading settings again rather than an automatic write retry.

## Verification and release gate

`node --test web/scripts/adoption-metrics.test.mjs` passes **16/16 deterministic tests**. Tests exercise clipboard promise ordering, distinct event IDs/retry/conflict, off-by-default zero IDs/network, forbidden-field canaries, streamed UTF-8 bounds/deadline, limits/outage, queue/opt-out, and actual Next route/auth-helper code against synthetic SDK responses. The actual hosted state route fixture proves only successful CAS saves schedule the deferred observer; stale saves, reads and auth failures do not. It also checks collector outage preserves a completed save, and account-switch/stale review protection. Web TypeScript checking passes. These are not a live PostgreSQL/RLS or deployed browser proof.

The additive migration is [`202610030002_adoption_metrics.sql`](../../../supabase/migrations/202610030002_adoption_metrics.sql). The rollback-only pgTAP fixtures are [`adoption_isolation.sql`](../../../supabase/tests/adoption_isolation.sql) and [`adoption_bounds.sql`](../../../supabase/tests/adoption_bounds.sql). Both executed successfully, unchanged, against disposable PostgreSQL 18.3 in PGlite 0.5.8 with the official pgcrypto/pgTAP extensions: **25 isolation and 12 quota/retention assertions**. The student baseline adds five assertions and the remote companion adds 34, for 76 executed SQL assertions. Five JavaScript/PostgreSQL request-hash probes additionally cover quoting, whitespace and Unicode.

The [test-only runner](../../../web/scripts/verify-optional-sql.mjs) requires explicit `--install-runtime` opt-in. It installs pinned official packages only into a temporary directory with lifecycle scripts disabled, then removes that directory. It uses synthetic `auth.users`, `auth.uid()`, `auth.jwt()` and roles; no project dependency, package lock, global runtime or cloud configuration is changed. The [verification artifact](../../../artifacts/optional-sql-verification.json) records exact migration/fixture hashes, PostgreSQL version, TAP output and remaining gates. This is actual SQL/function/table-privilege/RLS execution, **not live Supabase/GoTrue, real JWT revocation, concurrent connection, deployed scheduler or browser proof**. PGlite uses one session, so serialized calls do not establish concurrent lock correctness. This workstation still has no `psql` or PostgreSQL daemon. [Official PGlite usage](https://pglite.dev/docs/), [extensions](https://pglite.dev/extensions/).

To repeat the disposable execution from the repository root:

```sh
node web/scripts/verify-optional-sql.mjs --install-runtime
```

Before enabling collection:

1. Repeat migration and rollback fixture execution in a disposable real Supabase test project. Verify its actual auth schema, role/default privilege settings, GoTrue and JWT behavior. Race independent connections for dedup/quota, enrollment changes and opt-out versus in-flight activity; the executed one-session fixture does not establish that race proof.
2. Repeat retention/quota fixtures with actual Supabase roles and verify account deletion cascades. Local SQL already verifies thirty-day raw deletion, twelve-month aggregate deletion, raw quotas and the service-owner-only cleanup function under a transaction-fixed `now()`; preserve live test evidence separately.
3. Configure and verify a scheduled database/service-owner call to `adoption_purge_retention()`; the service-role-only cleanup function has no dynamic retention/query input. Do not expose a service key through an ordinary route or browser. Admin manual purge remains separately authenticated. Verify actual deletion while the site is idle or collection is off.
4. Provision authorized admin membership through a separately approved server/database operation. No admin was provisioned by this slice.
5. Wire the reviewed consent widgets/observer/save hook, test actual browser success/denial/manual copy/offline/opt-out and inspect every actual payload for canaries. Confirm copying and account use still work during collector failure.
6. Review deployed privacy notices and hosting log behavior, then enable the explicit feature flag only under approval. Verify an ordinary user cannot read owner metrics or any raw identity table. Production setup/account counts start only from actual enabled evidence.

No Vercel analytics/custom-event dependency or billed plan is enabled here. Provider visitor estimates, deployed live evidence and later local telemetry remain separate release work.
