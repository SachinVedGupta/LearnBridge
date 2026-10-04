'use client';
import { useEffect, useRef, useState } from 'react';
type Account = { id: string; provider: 'googledocs' | 'notion'; label: string };
type Row = { id: string; title: string; url: string; modified_at: string | null; selection_token: string };
type Bundle = { bundle_hash: string; provider: string; account_id: string; owner: { student_id: string }; academic_policy: string; retrieved_at: string; records: Array<{ id: string; title: string; text: string; sha256: string; limitations: string[] }>; limitations: string[] };
type Preview = { bundle: Bundle; review_hash: string; preview_token: string; expires_at: string };
type DownloadConfirmation = { preview: Preview; generation: number };
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
async function digest(text: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
const fieldClass = 'w-full rounded-lg border border-slate-600 bg-slate-900 p-3 text-white';
const buttonClass = 'rounded-lg border border-teal-500 px-4 py-2 text-teal-200 disabled:opacity-40';

export default function CloudOnboarding() {
  const [accounts, setAccounts] = useState<Account[]>([]), [account, setAccount] = useState(''), [query, setQuery] = useState(''), [policy, setPolicy] = useState('learning_support');
  const [rows, setRows] = useState<Row[]>([]), [selected, setSelected] = useState<Set<string>>(new Set()), [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [docsLink, setDocsLink] = useState('');
  const [confirmation, setConfirmation] = useState<DownloadConfirmation | null>(null);
  const state = useRef({ generation: 0, controller: null as AbortController | null, downloads: new Set<string>(), preview: null as Preview | null,
    reviewed: false, confirmation: null as DownloadConfirmation | null, exporting: null as DownloadConfirmation | null });
  state.current.preview = preview; state.current.reviewed = reviewed;
  function dismissConfirmation() { state.current.confirmation = null; setConfirmation(null); }
  function invalidate(clearRows = false) { state.current.generation++; state.current.controller?.abort(); state.current.controller = null; state.current.preview = null; state.current.reviewed = false; state.current.exporting = null; dismissConfirmation(); setBusy(''); setPreview(null); setReviewed(false); setError(''); setNotice(''); if (clearRows) { setRows([]); setSelected(new Set()); setSearched(false); } }
  async function request(action: string, body?: unknown) {
    const controller = new AbortController(); state.current.controller = controller;
    const response = await fetch(`/api/cloud-onboarding/${action}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
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
  const picked = accounts.find(item => `${item.provider}:${item.id}` === account), choice = picked ? { provider: picked.provider, account_id: picked.id } : null;
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
  return <main className="mx-auto max-w-5xl space-y-6 p-6 py-12">
    <p className="text-sm text-teal-300">Your accounts, your selected sources</p><h1 className="text-4xl font-semibold">Bring selected cloud notes to your laptop</h1>
    <p className="text-slate-300">Choose one of your own connected Google Docs or Notion accounts. Search and check up to three items, or supply one exact Google Docs link, then review the returned text and download a transfer file. Your local workspace imports it only after a separate review. Nothing is sent to an AI here.</p>
    <p className="text-slate-400">This is a manual selected snapshot. Original visuals, linked files, account completeness and later changes are not verified. <a className="text-teal-300 underline" href="/connections">Connect or review your own accounts</a>.</p>
    {error && <p role="alert" className="rounded-xl border border-amber-700 p-4 text-amber-200">{error}</p>}{notice && <p role="status" className="rounded-xl border border-teal-800 p-4 text-teal-100">{notice}</p>}
    <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">1. Choose one account and find exact sources</h2>
      <label className="block">Connected account<select className={fieldClass} value={account} onChange={event => { invalidate(true); setDocsLink(''); setAccount(event.target.value); }}><option value="">Choose an account</option>{accounts.map(item => <option key={`${item.provider}:${item.id}`} value={`${item.provider}:${item.id}`}>{item.label}</option>)}</select></label>
      {!accounts.length && <p className="text-slate-400">No eligible configured account choices were returned. Use Connections to connect your own account; developer or desktop accounts are never used as a fallback.</p>}
      <label className="block">Search phrase<input className={fieldClass} value={query} maxLength={200} placeholder="For example: my course notes" onChange={event => { invalidate(true); setQuery(event.target.value); }} /></label>
      <div className="flex flex-wrap gap-3"><button className={buttonClass} disabled={!choice || !!busy} onClick={() => void action('Checking provider schema', async generation => { await request('probe', choice); if (generation === state.current.generation) setNotice('The two read-only tool schemas are compatible. No document text was read by this check.'); })}>Check read-tool compatibility</button>
        <button className={buttonClass} disabled={!choice || !query.trim() || !!busy} onClick={() => { invalidate(true); void action('Searching metadata', async generation => { const result = await request('search', { ...choice, query }); if (generation === state.current.generation) { setRows(result.items); setSearched(true); setNotice(result.items.length ? 'Metadata search finished. Only the first 20 matches are shown; select items before reading text.' : 'No matching items were returned. Check the title or which items this connection can access.'); } }); }}>Search item metadata</button></div>
      {busy && <p role="status">{busy}…</p>}
    </section>
    <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">2. Select exact items to read</h2><p className="text-slate-400">Every checkbox starts unchecked. Search results contain metadata, not document bodies. Up to three selected text snapshots, each at most 20,000 UTF-8 bytes, can be previewed.</p>
      {rows.map(row => <label key={row.id} className="block rounded-lg border border-slate-700 p-3"><input type="checkbox" checked={selected.has(row.id)} disabled={!!busy || (!selected.has(row.id) && selected.size >= 3)} onChange={event => { invalidate(); setSelected(prior => { const next = new Set(prior); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; }); }} /> <span>{row.title}</span><span className="block break-all text-sm text-slate-400">{row.id} · modified {row.modified_at || 'not reported'}</span></label>)}
      {!rows.length && <p className="text-slate-400">{searched ? 'No selectable matches from this search. No document text was read.' : 'Run a specific metadata search to see selectable items.'}</p>}
      <label className="block">Academic policy<select className={fieldClass} value={policy} onChange={event => { invalidate(); setPolicy(event.target.value); }}><option value="learning_support">Learning support</option><option value="graded_restricted">Graded work: scaffolding and feedback only</option><option value="unrestricted">Personal or ungraded material</option></select></label>
      <button className={buttonClass} disabled={!choice || !selected.size || !!busy} onClick={() => { invalidate(); void action('Reading checked items', async generation => { const result = await request('preview', { ...choice, selection_tokens: rows.filter(row => selected.has(row.id)).map(row => row.selection_token), academic_policy: policy }); if (generation === state.current.generation) { setPreview(result); setReviewed(false); } }); }}>Read only checked items and prepare review</button>
      {picked?.provider === 'googledocs' && <div className="space-y-3 rounded-lg border border-slate-600 p-4"><h3 className="text-xl font-semibold">Or read one exact Google Docs link</h3>
        <p className="text-slate-400">Google Docs metadata search needs separate Google Drive permission, which your existing connection may not have. This option reads only the document ID you supply through your chosen Docs account; it performs no search and does not fetch the link itself. Access can still be denied by Google.</p>
        <label className="block">Exact Google Docs link<input className={fieldClass} value={docsLink} maxLength={1000} placeholder="https://docs.google.com/document/d/DOCUMENT_ID/edit" onChange={event => { invalidate(); setDocsLink(event.target.value); }} /></label>
        <p className="text-sm text-slate-400">Use exactly https://docs.google.com/document/d/…/edit. Remove query parameters and fragments. The title comes from the returned document, and its modification time and live freshness remain unchecked.</p>
        <button className={buttonClass} disabled={!choice || !docsLink || !!busy} onClick={() => { invalidate(); void action('Reading exact Docs link', async generation => { const result = await request('preview_link', { ...choice, url: docsLink, academic_policy: policy }); if (generation === state.current.generation) { setPreview(result); setReviewed(false); } }); }}>Read this exact Docs link</button>
      </div>}
    </section>
    {preview && <section className="space-y-4 rounded-xl border border-slate-700 p-5"><h2 className="text-2xl font-semibold">3. Review the entire returned text</h2><p className="break-all text-slate-400">Hosted student {preview.bundle.owner.student_id} · account {preview.bundle.account_id} · retrieved {preview.bundle.retrieved_at} · policy {preview.bundle.academic_policy}</p>
      {preview.bundle.records.map(record => <article key={record.id} className="space-y-3"><h3 className="text-xl font-semibold">{record.title}</h3><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4">{record.text || '(Empty returned text)'}</pre><ul className="list-disc space-y-1 pl-5 text-slate-400">{record.limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p className="break-all text-xs text-slate-400">Text SHA-256: {record.sha256}</p></article>)}
      <ul className="list-disc pl-5 text-slate-400">{preview.bundle.limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p className="break-all text-xs text-slate-400">Exact review SHA-256: {preview.review_hash}</p>
      <label className="block"><input type="checkbox" checked={reviewed} onChange={event => { if (!event.target.checked) { state.current.generation++; state.current.controller?.abort(); state.current.controller = null; state.current.exporting = null; dismissConfirmation(); setBusy(''); } state.current.reviewed = event.target.checked; setReviewed(event.target.checked); }} /> I reviewed all selected text, the account, academic policy and stated limitations.</label>
      <button className={buttonClass} disabled={!reviewed || !!busy || !!confirmation} onClick={armDownload}>Download reviewed selected-source bundle</button>
      {confirmation && <section role="dialog" aria-modal={false} aria-labelledby="cloud-download-confirmation-title" aria-describedby="cloud-download-confirmation-detail" className="space-y-3 rounded-xl border border-teal-500 bg-slate-900 p-5" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismissConfirmation(); } }}>
        <h3 id="cloud-download-confirmation-title" className="text-xl font-semibold">Confirm this private download</h3>
        <p id="cloud-download-confirmation-detail" className="break-all text-slate-300">Download {confirmation.preview.bundle.records.length} reviewed item(s) from {confirmation.preview.bundle.provider}, account {confirmation.preview.bundle.account_id}, for hosted student {confirmation.preview.bundle.owner.student_id}. Academic policy: {confirmation.preview.bundle.academic_policy}.</p>
        <p className="break-all text-slate-300">File: LearnBridge-selected-{confirmation.preview.bundle.provider}.json. Destination: your browser’s download location on this device. This creates a separate private text file; it does not import notes or grant model access.</p>
        <p className="text-sm text-slate-400">Cancel keeps your reviewed preview. Changing the account, selection or policy, unchecking review, or waiting for expiry cancels this confirmation.</p>
        <div className="flex flex-wrap gap-3"><button type="button" className={buttonClass} onClick={dismissConfirmation}>Cancel</button><button type="button" className={buttonClass} disabled={!!busy} onClick={() => confirmDownload(confirmation)}>Confirm private download</button></div>
      </section>}
      <p className="text-slate-400">Next: in your paired local dashboard, open <strong>Cloud sources</strong>, choose the downloaded JSON file and confirm that its account is yours. Review the private note import separately. AI sharing stays a separate choice in Agent &amp; review.</p>
    </section>}
  </main>;
}
