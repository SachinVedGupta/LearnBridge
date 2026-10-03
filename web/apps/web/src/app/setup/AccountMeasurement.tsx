'use client';

import { useState } from 'react';
import { ADOPTION_CONSENT_VERSION } from '@/lib/adoption/policy.mjs';

type Enrollment = { revision: number; review_hash: string; enabled: boolean; directory_enabled: boolean };
/** Optional authenticated choice. Does not read auth/profile until the student
 * explicitly opens this setting, and never associates anonymous click history. */
export default function AccountMeasurement({ enabled = false }: { enabled?: boolean }) {
  const [current, setCurrent] = useState<Enrollment | null>(null), [counts, setCounts] = useState(false), [directory, setDirectory] = useState(false), [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  async function load() {
    if (!enabled || pending) return; setPending(true);
    try {
      const response = await fetch('/api/adoption/enrollment', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in before choosing account reporting. Local setup and anonymous choices remain independent.' : 'Account reporting is unavailable. Setup still works.');
      const body = await response.json(); const value = body.enrollment;
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.enabled !== 'boolean' || typeof value.directory_enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(body.review_hash || '')) throw new Error('Account reporting is unavailable.');
      setCurrent({ ...value, review_hash: body.review_hash }); setCounts(value.enabled); setDirectory(value.directory_enabled); setNotice('Review the two independent choices below before saving.');
    } catch (error) { setCurrent(null); setNotice(error instanceof Error ? error.message : 'Account reporting is unavailable.'); } finally { setPending(false); }
  }
  async function save() {
    if (!enabled || !current || pending) return; setPending(true);
    try {
      const response = await fetch('/api/adoption/enrollment', { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: current.revision, expected_review_hash: current.review_hash, enabled: counts, directory_enabled: counts && directory, consent_version: ADOPTION_CONSENT_VERSION }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'These settings changed elsewhere. Load them again before saving.' : 'Settings could not be saved. Your account and setup still work.');
      const body = await response.json(); const value = body.enrollment;
      if (!value || value.revision !== current.revision + 1 || value.enabled !== counts || value.directory_enabled !== (counts && directory) || !/^[a-f0-9]{64}$/.test(body.review_hash || '')) throw new Error('Read back your settings again to confirm their outcome.');
      setCurrent({ ...value, review_hash: body.review_hash }); setCounts(value.enabled); setDirectory(value.directory_enabled); setNotice(value.enabled ? 'Exact account reporting choices saved. Anonymous history remains separate, and local reporting is off.' : 'Account reporting disabled. Directory access stopped and raw account activity was removed. Anonymous aggregate counts can remain for 12 months.');
    } catch (error) { setCurrent(null); setNotice(error instanceof Error ? error.message : 'Settings could not be saved.'); } finally { setPending(false); }
  }
  if (!enabled) return null;
  return <section aria-labelledby="account-measurement-heading" className="mt-6 rounded-xl border border-slate-800 p-5 text-sm leading-6 text-slate-300">
    <h2 id="account-measurement-heading" className="font-semibold text-white">Optional account reporting</h2>
    <p className="mt-2">A signed-in account can separately contribute a setup enrollment and successful hosted task/note saves to owner-only aggregates. This does not prove a new person, local install or learning outcome. Local use needs no account.</p>
    <p className="mt-2">An additional directory choice lets authorized LearnBridge admins see your confirmed account email and provider/user-supplied display name for product operations. A display name is not verified legal identity. Neither choice grants marketing consent or access to your coursework. No anonymous click history is joined to your account.</p>
    <p className="mt-2">Raw activity lasts at most 30 days and is removed on account reporting opt-out. Consent settings remain private until changed or the account is deleted. Anonymous aggregate counts can remain for 12 months.</p>
    <button type="button" onClick={load} disabled={!enabled || pending} className="mt-3 rounded-lg border border-slate-600 px-4 py-2 text-white disabled:opacity-50">{pending ? 'Working…' : 'Load my account reporting choices'}</button>
    {current && <div className="mt-3 space-y-3">
      <label className="flex gap-3"><input type="checkbox" checked={counts} disabled={pending} onChange={event => { setCounts(event.target.checked); if (!event.target.checked) setDirectory(false); }} /><span>I choose the disclosed account enrollment and successful hosted-save counts.</span></label>
      <label className="flex gap-3"><input type="checkbox" checked={directory} disabled={!counts || pending} onChange={event => setDirectory(event.target.checked)} /><span>I separately allow authorized admins to see my confirmed account email and display name.</span></label>
      <button type="button" onClick={save} disabled={pending} className="rounded-lg bg-teal-300 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Save these exact reporting choices</button>
    </div>}
    <p role="status" aria-live="polite" className="mt-2">{notice || (!enabled ? 'Account reporting is currently unavailable; no enrollment request is sent.' : 'No account setting is read until you open it.')}</p>
  </section>;
}
