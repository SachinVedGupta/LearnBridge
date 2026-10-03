'use client';

import { useRef, useState } from 'react';
import { copyPrompt } from './copy-prompt';
import { SETUP_PROMPT, SETUP_PROMPT_VERSION } from './setup-content';
import { useSetupMeasurement } from './SetupMeasurement';

export default function SetupPrompt() {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const text = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const measurement = useSetupMeasurement();

  async function copy() {
    if (pending.current) return;
    pending.current = true;
    setState('copying');
    try {
      const outcome = await copyPrompt(SETUP_PROMPT, navigator.clipboard, measurement.observeCopySucceeded);
      setState(outcome);
      if (outcome === 'failed') {
        measurement.observeCopyFailed();
        text.current?.focus();
        text.current?.select();
      }
    } catch {
      // Some browser policies also prevent reading navigator.clipboard.
      setState('failed');
      measurement.observeCopyFailed();
      text.current?.focus();
      text.current?.select();
    } finally {
      pending.current = false;
    }
  }

  function select() {
    text.current?.focus();
    text.current?.select();
  }

  return (
    <section aria-labelledby="agent-setup-heading" className="rounded-2xl border border-teal-300/30 bg-teal-300/5 p-5 sm:p-8">
      <p className="text-sm font-medium text-teal-300">Bring your coding agent</p>
      <h2 id="agent-setup-heading" className="mt-2 text-2xl font-semibold text-white">Let your agent set it up and verify it</h2>
      <p className="mt-3 max-w-2xl leading-7 text-slate-300">Paste this prompt into Codex, Claude Code or another coding agent with access to your computer. It sets up the local workspace with sample data first. You choose personal sources and sharing permissions separately.</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={copy} disabled={state === 'copying'} className="rounded-lg bg-teal-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-teal-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 disabled:opacity-50">
          {state === 'copying' ? 'Copying…' : state === 'copied' ? 'Copy again' : 'Copy setup prompt'}
        </button>
        <button type="button" onClick={select} className="rounded-lg border border-slate-600 px-4 py-3 text-sm text-slate-200 hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300">Select prompt manually</button>
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-12 text-sm leading-6 text-slate-300">
        {state === 'copied' ? 'Copied. Paste it into your coding agent to begin; copying does not install LearnBridge.' : state === 'failed' ? 'Automatic copy was unavailable. The prompt is selected below; use your browser’s Copy action or your keyboard shortcut.' : state === 'copying' ? 'Waiting for your browser to confirm the copy…' : 'You can read and select the full prompt below. No account is needed for local setup.'}
      </p>
      <label htmlFor="learnbridge-setup-prompt" className="mt-3 block text-sm font-medium text-slate-200">Full setup prompt <span className="ml-1 break-all font-normal text-slate-400">· {SETUP_PROMPT_VERSION}</span></label>
      <textarea ref={text} id="learnbridge-setup-prompt" readOnly value={SETUP_PROMPT} spellCheck={false} rows={12} className="mt-2 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-300 focus:border-teal-300 focus:outline-none" />
      <p className="mt-3 text-xs leading-5 text-slate-400">Copying does not enroll local reporting or remote access. Optional setup observations are controlled separately below. Website hosting handles ordinary web requests under the <a href="/privacy" className="underline hover:text-teal-300">Privacy Policy</a>.</p>
    </section>
  );
}
