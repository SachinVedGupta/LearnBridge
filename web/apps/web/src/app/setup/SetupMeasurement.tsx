'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createSetupAdoptionClient } from '@/lib/adoption/client.mjs';
import { ADOPTION_CONSENT_VERSION, ADOPTION_FIELDS } from '@/lib/adoption/policy.mjs';

const MeasurementContext = createContext({ observeCopySucceeded: () => {}, observeCopyFailed: () => {} });
export const useSetupMeasurement = () => useContext(MeasurementContext);

/** The server must explicitly pass enabled=true after the release gates. A
 * page/session choice is separate from accounts, local setup and relay consent. */
export default function SetupMeasurement({ enabled = false, children }: { enabled?: boolean; children: React.ReactNode }) {
  const client = useMemo(() => createSetupAdoptionClient({ enabled }), [enabled]);
  const [optedIn, setOptedIn] = useState(false);
  useEffect(() => () => { client.optOut(); }, [client]);
  const observers = useMemo(() => ({ observeCopySucceeded: () => { client.observeCopySucceeded(); }, observeCopyFailed: () => { client.observeCopyFailed(); } }), [client]);
  return <MeasurementContext.Provider value={observers}>
    {children}
    {!enabled ? <p className="mt-4 text-sm leading-6 text-slate-400">Setup measurement is currently off. Copying this prompt does not report setup activity or enroll your account.</p> : <section aria-labelledby="setup-measurement-heading" className="mt-6 rounded-xl border border-slate-800 p-5 text-sm leading-6 text-slate-300">
      <h2 id="setup-measurement-heading" className="font-semibold text-white">Optional setup observations</h2>
      <p>{enabled ? 'Off unless you choose it for this page session. You can share that you viewed this setup page and whether a browser copy succeeded or failed.' : 'Setup measurement is currently off. Copying the prompt and local setup work without it.'}</p>
      <p className="mt-2">Fields: random ID for each event, event type, fixed /setup route, schema and prompt version. No email, name, account, device ID, prompt, referrer, URL query, coursework or local files. Hosting still handles ordinary requests under its own policies.</p>
      <p className="mt-2">Raw observations expire after 30 days; aggregate counts may remain for 12 months. Interactions can be forged and do not count unique people or installations. Turning this off clears this page’s unsent queue and stops future sends; already received observations follow retention. No local reporting is enrolled.</p>
      <label className="mt-3 flex items-start gap-3"><input type="checkbox" checked={optedIn} disabled={!enabled} onChange={event => {
        if (event.target.checked) { const selected = client.optIn({ consent_version: ADOPTION_CONSENT_VERSION, reviewed_fields: [...ADOPTION_FIELDS] }); setOptedIn(selected); if (selected) client.observePageView(); }
        else { client.optOut(); setOptedIn(false); }
      }} /><span>I reviewed these fields and choose anonymous setup observations for this page session.</span></label>
      <p aria-live="polite" className="mt-2">{optedIn ? 'Setup observations selected. Collection failure never blocks the prompt.' : 'No setup observations selected.'}</p>
    </section>}
  </MeasurementContext.Provider>;
}
