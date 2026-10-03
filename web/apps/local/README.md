# Local dashboard

Dependency-free HTML, CSS and JavaScript for the local LearnBridge runtime. This is a separate static app; it does not import the hosted Next.js website, Supabase, Composio, provider secrets or AI clients.

Build with `npm --prefix web/apps/local run build`. The output contains only `index.html`, `app.js` and `styles.css`. Serve it through the LearnBridge local runtime, at the same loopback origin as `/api/local/v1`; a generic static server cannot provide the private workspace APIs.

The browser pairs using the launcher's single-use code. The runtime holds the session in an HTTP-only cookie. JavaScript keeps the request nonce and private inputs in memory, with no local storage. Mutations and private reads go through the runtime's session, origin and nonce checks. The server remains responsible for authorization and validation; hiding a page is not an access control.

The dashboard supports manual task creation, completion, editing and deletion, plus multiple plain-text notes with create, read, update and delete. Mutations include the current record revision. A conflicting note keeps the unsaved text and offers an explicit reload; a conflicting task keeps its edit form. Note saves are independently read back before showing success. Private text is rendered using `textContent` or input values; there is no HTML interpreter or external network dependency.

Create attempts have an in-memory idempotency key, reused for an unchanged retry within this page session. This prevents a lost response from duplicating the same task/note when the student retries. The key and retry payload are cleared on disconnect; they are not persisted in the browser. Changing the payload starts a different attempt.

Deletion removes a record from the active workspace and note search. Immutable note versions and deleted metadata can remain in the local database and backups. This foundation has no selective physical purge feature; the UI does not describe deletion as erasing all copies.

Setup displays the actual runtime capability report. Source discovery, reviewed profiles and app connections are explicitly described as unavailable in this foundation. The dashboard does not claim that pairing connects an AI tutor or scans student accounts.

Verification should use a temporary synthetic installation: pair, save/reload/edit task and note, trigger a competing revision, check unsaved text survives, restart the runtime and read the persisted records, then disconnect and verify private routes reject the previous session. UI automation should additionally check a narrow mobile viewport and keyboard navigation. Do not use real student files for fixture verification.
