'use client';
import { useEffect, useRef, useState } from 'react';
type Account = { id: string; provider: 'gmail'; label: string };
type EmailMetadata = { kind: 'email'; message_id: string; thread_id: string; from: string | null; to: string | null; sent_at: string | null; received_at: null; date_header: string | null; provider_timestamp: string | null; timestamp_semantics: string; selected_scope: { folder: string; start_date: string; end_date: string; subject_phrase: string } };
type Row = { id: string; title: string; thread_id: string; from: string | null; to: string | null; provider_timestamp: string | null; selection_token: string };
type Bundle = { bundle_hash: string; provider: string; account_id: string; owner: { student_id: string }; academic_policy: string; retrieved_at: string; records: Array<{ id: string; title: string; text: string; sha256: string; source_metadata: EmailMetadata; limitations: string[] }>; limitations: string[] };
type Preview = { bundle: Bundle; review_hash: string; preview_token: string; expires_at: string };
type DownloadConfirmation = { preview: Preview; generation: number };
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
async function digest(text: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
const fieldClass = 'w-full rounded-lg border border-slate-600 bg-slate-900 p-3 text-white';
const buttonClass = 'rounded-lg border border-teal-500 px-4 py-2 text-teal-200 disabled:opacity-40';

export default function EmailOnboarding() {
  const [accounts, setAccounts] = useState<Account[]>([]), [account, setAccount] = useState(''), [query, setQuery] = useState(''), [folder, setFolder] = useState(''), [startDate, setStartDate] = useState(''), [endDate, setEndDate] = useState(''), [policy, setPolicy] = useState('learning_support');
  const [rows, setRows] = useState<Row[]>([]), [selected, setSelected] = useState<Set<string>>(new Set()), [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [confirmation, setConfirmation] = useState<DownloadConfirmation | null>(null);
  const state = useRef({ generation: 0, controller: null as AbortController | null, downloads: new Set<string>(), preview: null as Preview | null,
    reviewed: false, confirmation: null as DownloadConfirmation | null, exporting: null as DownloadConfirmation | null });
  state.current.preview = preview; state.current.reviewed = reviewed;
  function dismissConfirmation() { state.current.confirmation = null; setConfirmation(null); }
  function invalidate(clearRows = false) { state.current.generation++; state.current.controller?.abort(); state.current.controller = null; state.current.preview = null; state.current.reviewed = false; state.current.exporting = null; dismissConfirmation(); setBusy(''); setPreview(null); setReviewed(false); setError(''); setNotice(''); if (clearRows) { setRows([]); setSelected(new Set()); setSearched(false); } }
  async function request(action: string, body?: unknown) {
    const controller = new AbortController(); state.current.controller = controller;
    const response = await fetch(`/api/email-onboarding/${action}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'The selected-source operation did not finish.'); return result;
  }
  async function action(label: string, callback: (generation: number) => Promise<void>) {
    const generation = state.current.generation; dismissConfirmation(); setBusy(label); setError(''); setNotice('');
    try { await callback(generation); } catch (problem) { if (generation === state.current.generation) setError(problem instanceof Error ? problem.message : 'The selected-source operation did not finish.'); }
    finally { if (generation === state.current.generation) { state.current.controller = null; setBusy(''); } }
  }
  useEffect(() => {
    void action('Checking account choices', async generation => { const result = await request('accounts'); if (generation === state.current.generation) { setAccounts(result.items); if (result.coverage === 'partial') setNotice('The account list is partial. Only the returned configured accounts can be selected.'); } });
    return () => { state.current.generation++; state.current.controller?.abort(); state.current.preview = null; state.current.reviewed = false; state.current.confirmation = null; state.current.exporting = null; for (const url of state.current.downloads) URL.revokeObjectURL(url); state.current.downloads.clear(); };
  }, []);
  useEffect(() => { if (!preview) return; const timer = setTimeout(() => { invalidate(); setNotice('This preview expired. Read and review your exact selection again.'); }, Math.max(0, Date.parse(preview.expires_at) - Date.now())); return () => clearTimeout(timer); }, [preview]);
  const picked = accounts.find(item => item.id === account), choice = picked ? { account_id: picked.id } : null;
  function currentReview(reviewedPreview: Preview, generation: number) {
    const expires = Date.parse(reviewedPreview.expires_at);
    return generation === state.current.generation && state.current.preview === reviewedPreview && state.current.reviewed && Number.isFinite(expires) && expires > Date.now();
  }
  function armDownload() {
    const reviewedPreview = state.current.preview;
    if (!reviewedPreview || !currentReview(reviewedPreview, state.current.generation) || state.current.exporting) { dismissConfirmation(); setError('Review the current complete selected text before downloading.'); return; }
    const next = { preview: reviewedPreview, generation: state.current.generation }; state.current.confirmation = next; setConfirmation(next); setError(''); setNotice('');
  }
  function confirmDownload(candidate: DownloadConfirmation) {
    if (state.current.confirmation !== candidate) return;
    if (!currentReview(candidate.preview, candidate.generation) || state.current.exporting) { dismissConfirmation(); setError('This review changed or expired. Read and review the exact selection again.'); return; }
    dismissConfirmation(); state.current.exporting = candidate;
    void action('Preparing reviewed transfer file', generation => download(generation, candidate.preview)).finally(() => { if (state.current.exporting === candidate) state.current.exporting = null; });
  }
  async function download(generation: number, reviewedPreview: Preview) {
    if (!currentReview(reviewedPreview, generation)) throw new Error('Review the current complete selected text before downloading.');
    const result = await request('export', { preview_token: reviewedPreview.preview_token, review_hash: reviewedPreview.review_hash, confirm: true });
    if (!currentReview(reviewedPreview, generation)) return;
    const { bundle_hash, ...body } = result.bundle;
    if (bundle_hash !== reviewedPreview.review_hash || await digest(canonical(body)) !== bundle_hash || result.sharing !== 'not_granted' || result.filename !== `LearnBridge-selected-${reviewedPreview.bundle.provider}.json`) throw new Error('The bundle did not match this exact review. No download was prepared.');
    for (const record of result.bundle.records) if (await digest(record.text) !== record.sha256) throw new Error('The selected text did not match its source hash. No download was prepared.');
    if (!currentReview(reviewedPreview, generation)) return;
    // The server's full-bundle byte bound uses this exact compact encoding.
    // Pretty printing or adding a newline would change a near-limit file size.
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.bundle)], { type: 'application/json' })); state.current.downloads.add(url);
    const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click(); setTimeout(() => { URL.revokeObjectURL(url); state.current.downloads.delete(url); }, 30000);
    setNotice('Verified bundle download prepared. Open Cloud sources in your paired local dashboard, choose this JSON file and review it there. Saving this file does not import it or grant AI sharing.');
  }
  const scope = { folder, start_date: startDate, end_date: endDate, subject_phrase: query };
  return <main className="mx-auto max-w-5xl space-y-6 p-6 py-12">
    <p className="text-sm text-teal-300">Your mailbox, your selected messages</p><h1 className="text-4xl font-semibold">Bring selected email to your laptop</h1>
    <p className="text-slate-300">Choose your connected Gmail account, one folder, a date window and a subject phrase. Review up to three exact messages, then download a private transfer file. Your local workspace imports it only after another review. Nothing is sent to AI here.</p>
    <p className="text-slate-400">This is a manual snapshot. We do not send mail, change labels, download attachments, fetch other thread messages or follow links. <a className="text-teal-300 underline" href="/connections">Review your connections</a> · <a className="text-teal-300 underline" href="/onboarding/cloud">Choose Docs or Notion instead</a>.</p>
    {error && <p role="alert" className="rounded-xl border border-amber-700 p-4 text-amber-200">{error}</p>}{notice && <p role="status" className="rounded-xl border border-teal-800 p-4 text-teal-100">{notice}</p>}
    <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">1. Choose the exact metadata search</h2>
      <label className="block">Connected Gmail account<select className={fieldClass} value={account} onChange={event => { invalidate(true); setAccount(event.target.value); }}><option value="">Choose your account</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {!accounts.length && <p className="text-slate-400">No eligible Gmail connection was returned. Connect your own Gmail account in Connections. Developer and desktop accounts are never used.</p>}
      <label className="block">Folder<select className={fieldClass} value={folder} onChange={event => { invalidate(true); setFolder(event.target.value); }}><option value="">Choose one folder</option><option value="INBOX">Inbox</option><option value="SENT">Sent</option><option value="STARRED">Starred</option></select></label>
      <div className="grid gap-4 sm:grid-cols-2"><label className="block">Start UTC date<input type="date" className={fieldClass} value={startDate} onChange={event => { invalidate(true); setStartDate(event.target.value); }} /></label><label className="block">End UTC date<input type="date" className={fieldClass} value={endDate} onChange={event => { invalidate(true); setEndDate(event.target.value); }} /></label></div>
      <label className="block">Subject phrase<input className={fieldClass} value={query} maxLength={200} placeholder="For example: lecture" onChange={event => { invalidate(true); setQuery(event.target.value); }} /></label>
      <p className="text-sm text-slate-400">Up to 90 UTC days and 20 matches. Search only a specific subject phrase; quotes, backslashes and search operators are refused. The search requests metadata. Unexpected text fields received by the server are discarded and their byte count is reported.</p>
      <div className="flex flex-wrap gap-3"><button className={buttonClass} disabled={!choice || !!busy} onClick={() => void action('Checking read tools', async generation => { await request('probe', choice); if (generation === state.current.generation) setNotice('The pinned Gmail read-tool schemas are compatible. This check did not fetch messages or change permissions.'); })}>Check read-tool compatibility</button>
        <button className={buttonClass} disabled={!choice || !folder || !startDate || !endDate || !query.trim() || !!busy} onClick={() => { invalidate(true); void action('Searching selected metadata', async generation => { const result = await request('search', { ...choice, scope }); if (generation === state.current.generation) { setRows(result.items); setSearched(true); setNotice(`Metadata returned: ${result.items.length} message(s), first page only. Unexpected content discarded by the server: ${result.unexpected_content_bytes} serialized bytes. Select exact messages before reading their bodies.`); } }); }}>Search selected email metadata</button>
        <button className={buttonClass} onClick={() => { invalidate(true); setAccount(''); setFolder(''); setStartDate(''); setEndDate(''); setQuery(''); }}>Clear selection</button></div>
      {busy && <p role="status">{busy}…</p>}
    </section>
    <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">2. Choose exact messages</h2><p className="text-slate-400">Every checkbox starts unchecked. Up to three selected plaintext snapshots, each at most 20,000 UTF-8 bytes, can be read. Addresses below are private provider-reported source metadata, not confirmed profile facts.</p>
      {rows.map(row => <label key={row.id} className="block rounded-lg border border-slate-700 p-3"><input type="checkbox" checked={selected.has(row.id)} disabled={!!busy || (!selected.has(row.id) && selected.size >= 3)} onChange={event => { invalidate(); setSelected(prior => { const next = new Set(prior); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; }); }} /> <span>{row.title}</span><span className="block break-all text-sm text-slate-400">From: {row.from || 'not reported'} · To: {row.to || 'not reported'}<br />Message {row.id} · provider timestamp {row.provider_timestamp || 'not reported'} (meaning unverified)</span></label>)}
      {!rows.length && <p className="text-slate-400">{searched ? 'No selectable matches from this partial search. No complete mailbox coverage is claimed.' : 'Choose a specific metadata search first.'}</p>}
      <label className="block">Academic policy<select className={fieldClass} value={policy} onChange={event => { invalidate(); setPolicy(event.target.value); }}><option value="learning_support">Learning support</option><option value="graded_restricted">Graded work: scaffolding and feedback only</option><option value="unrestricted">Personal or ungraded material</option></select></label>
      <button className={buttonClass} disabled={!choice || !selected.size || !!busy} onClick={() => { invalidate(); void action('Reading only checked messages', async generation => { const result = await request('preview', { ...choice, selection_tokens: rows.filter(row => selected.has(row.id)).map(row => row.selection_token), academic_policy: policy }); if (generation === state.current.generation) { setPreview(result); setReviewed(false); } }); }}>Read only checked messages</button>
      <p className="text-sm text-slate-400">Only inline UTF-8/ASCII text/plain MIME parts are supported. HTML-only messages and other encodings require a separately reviewed manual excerpt. A full selected MIME response may contain extra inline bytes; attachments are never fetched through an attachment tool or exported.</p>
    </section>
    {preview && <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">3. Review private text and provenance</h2><p className="break-all text-slate-400">Hosted student {preview.bundle.owner.student_id} · account {preview.bundle.account_id} · retrieved {preview.bundle.retrieved_at} · policy {preview.bundle.academic_policy}</p>
      {preview.bundle.records.map(record => <article key={record.id} className="space-y-3"><h3 className="text-xl font-semibold">{record.title}</h3><p className="break-all text-slate-400">From: {record.source_metadata.from || 'not reported'} · To: {record.source_metadata.to || 'not reported'}<br />Message: {record.id} · thread: {record.source_metadata.thread_id}<br />Date header: {record.source_metadata.date_header || 'not reported'}<br />Sent time from Date header: {record.source_metadata.sent_at || 'not reported'} · received time: not reported<br />Provider timestamp: {record.source_metadata.provider_timestamp || 'not reported'} (meaning unverified)<br />Selected folder: {record.source_metadata.selected_scope.folder} · UTC dates: {record.source_metadata.selected_scope.start_date} to {record.source_metadata.selected_scope.end_date} · subject: {record.source_metadata.selected_scope.subject_phrase}</p><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4">{record.text || '(Empty plaintext body)'}</pre><ul className="list-disc space-y-1 pl-5 text-slate-400">{record.limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p className="break-all text-xs text-slate-400">Text SHA-256: {record.sha256}</p></article>)}
      <ul className="list-disc pl-5 text-slate-400">{preview.bundle.limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p className="break-all text-xs text-slate-400">Exact review SHA-256: {preview.review_hash}</p>
      <label className="block"><input type="checkbox" checked={reviewed} onChange={event => { if (!event.target.checked) { state.current.generation++; state.current.controller?.abort(); state.current.controller = null; state.current.exporting = null; dismissConfirmation(); setBusy(''); } state.current.reviewed = event.target.checked; setReviewed(event.target.checked); }} /> I reviewed every selected text, the private address metadata, my account, the policy and limitations.</label>
      <button className={buttonClass} disabled={!reviewed || !!busy || !!confirmation} onClick={armDownload}>Download reviewed email bundle</button>
      {confirmation && <section role="dialog" aria-modal={false} aria-labelledby="email-download-title" className="space-y-3 rounded-xl border border-teal-500 bg-slate-900 p-5" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismissConfirmation(); } }}><h3 id="email-download-title" className="text-xl font-semibold">Confirm this private email download</h3>
        <p className="break-all text-slate-300">Download {confirmation.preview.bundle.records.length} reviewed email(s) from account {confirmation.preview.bundle.account_id}, for hosted student {confirmation.preview.bundle.owner.student_id}. Policy: {confirmation.preview.bundle.academic_policy}. File: LearnBridge-selected-gmail.json. Destination: this device’s browser download location.</p>
        <p className="text-sm text-slate-400">This file includes private message text and sender/recipient metadata. It does not import notes, verify ownership on your laptop or grant AI access. Cancel keeps your review; any changed selection or expiry cancels this confirmation.</p>
        <div className="flex flex-wrap gap-3"><button type="button" className={buttonClass} onClick={dismissConfirmation}>Cancel</button><button type="button" className={buttonClass} disabled={!!busy} onClick={() => confirmDownload(confirmation)}>Confirm private download</button></div>
      </section>}
      <p className="text-slate-400">Next: open <strong>Cloud sources</strong> in your paired local workspace, choose this JSON file, confirm the exported account is yours and review the private note import. Model sharing requires a separate choice in Agent &amp; review.</p>
    </section>}
  </main>;
}
