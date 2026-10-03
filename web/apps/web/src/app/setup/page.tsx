import type { Metadata } from 'next';
import SetupPrompt from './SetupPrompt';
import SetupMeasurement from './SetupMeasurement';
import AccountMeasurement from './AccountMeasurement';
import { AGENT_GUIDE, LEARNBRIDGE_REPOSITORY, LOCAL_GUIDE, SETUP_GUIDE } from './setup-content';

export const metadata: Metadata = {
  title: 'Set up your student workspace · LearnBridge',
  description: 'Use LearnBridge online, or set up a private local student workspace with your own Codex or Claude Code host.',
};
export const dynamic = 'force-dynamic';

const linkStyle = 'text-teal-300 underline decoration-teal-300/40 underline-offset-4 hover:text-teal-200';

export default function SetupPage() {
  const measurementEnabled = process.env.LEARNBRIDGE_ADOPTION_ENABLED === '1';
  return (
    <main className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="text-sm font-medium text-teal-300">Your learning, your workflow</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">A student workspace that fits how you work.</h1>
      <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">Use LearnBridge in your browser, or keep your workspace on your own computer and connect your coding agent. Choose the edition that suits you.</p>

      <div className="my-9 grid gap-5 md:grid-cols-2">
        <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-6" aria-labelledby="online-heading">
          <p className="text-sm text-slate-400">Online edition</p>
          <h2 id="online-heading" className="mt-2 text-2xl font-semibold text-white">Open it and sign in</h2>
          <p className="mt-3 leading-7 text-slate-300">Keep account-linked tasks and drafts, use the tutor and choose your own supported app connections. Provider availability and AI usage limits apply.</p>
          <a href="/login" className="mt-5 inline-block rounded-lg border border-slate-500 px-4 py-3 font-medium text-white hover:border-teal-300">Use the online app</a>
          <p className="mt-3 text-sm leading-6 text-slate-400">An online account is optional for local use. Signing in does not install or connect your computer.</p>
        </section>
        <section className="rounded-2xl border border-teal-300/25 bg-slate-900/60 p-6" aria-labelledby="local-heading">
          <p className="text-sm text-teal-300">Local edition</p>
          <h2 id="local-heading" className="mt-2 text-2xl font-semibold text-white">Keep a private workspace</h2>
          <p className="mt-3 leading-7 text-slate-300">Keep tasks and notes locally, plan study sessions, prepare reviewed drafts and manage student routines from selected sources or details you enter. Import selected text, Markdown, supported PDF text, Word (.docx) paragraphs and PowerPoint (.pptx) slide text, then review changes proposed through your Codex or Claude MCP bridge.</p>
          <a href="#agent-setup-heading" className="mt-5 inline-block rounded-lg bg-teal-300 px-4 py-3 font-semibold text-slate-950 hover:bg-teal-200">Set up with your agent</a>
          <p className="mt-3 text-sm leading-6 text-slate-400">Basic tasks and notes need no cloud service keys. Your agent uses its own official account and permissions.</p>
        </section>
      </div>

      <SetupMeasurement enabled={measurementEnabled}><SetupPrompt /></SetupMeasurement>
      <AccountMeasurement enabled={measurementEnabled} />

      <section aria-labelledby="requirements-heading" className="mt-10 rounded-2xl border border-slate-800 p-6">
        <h2 id="requirements-heading" className="text-2xl font-semibold text-white">Before you start locally</h2>
        <ul className="mt-4 list-disc space-y-3 pl-5 leading-7 text-slate-300">
          <li>Node.js 22.16 or newer and npm. The setup agent checks your installed versions.</li>
          <li>macOS arm64 is the verified target. Linux is experimental; Windows local storage is not supported yet.</li>
          <li>Selected file imports need the project Python environment and its file-safety support. The agent checks the prerequisites without changing global Python. Word (.docx) and PowerPoint (.pptx) imports extract text with the project importer; legacy Office files, macros, passwords and external links are not supported.</li>
          <li>PDF text extraction additionally needs macOS PDFKit and the supported Swift toolchain. PDF imports are limited to 4 MB and 200 pages; Word and PowerPoint imports are limited to 4 MB and 1,000 sections. Each imported file can save at most 48 KB of extracted text. Larger files need a smaller selected file or text export.</li>
          <li>Review the original for diagrams, images, formatting and omitted content. These imports provide text with source references; they do not reproduce Office layouts or perform OCR on scanned PDFs.</li>
          <li>Agent features need an installed official Codex or Claude Code host, its normal account access and your host approvals. A model subscription is separate from LearnBridge; there is no automatic paid API fallback.</li>
        </ul>
      </section>

      <section aria-labelledby="manual-heading" className="mt-10">
        <h2 id="manual-heading" className="text-2xl font-semibold text-white">Prefer to set it up yourself?</h2>
        <p className="mt-3 leading-7 text-slate-300">Clone <a href={LEARNBRIDGE_REPOSITORY} className={linkStyle}>the repository</a> into a new folder, review its instructions and run these commands from that checkout:</p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm leading-7 text-slate-200"><code>{'npm run setup\nnpm run local:setup\nnpm run local:doctor\nnpm run local:start'}</code></pre>
        <p className="mt-3 leading-7 text-slate-300">Open the loopback address shown by the launcher and enter its single-use pairing code in the form. Keep the launcher running while you use the workspace. Follow <a href={LOCAL_GUIDE} className={linkStyle}>local setup and recovery</a> for the Python prerequisite, verification, backups and safe restore; follow <a href={AGENT_GUIDE} className={linkStyle}>agent setup</a> for project-only MCP registration.</p>
      </section>

      <section aria-labelledby="privacy-heading" className="mt-10 border-t border-slate-800 pt-8">
        <h2 id="privacy-heading" className="text-2xl font-semibold text-white">You choose what it can see</h2>
        <p className="mt-3 leading-7 text-slate-300">Setup uses sample records first. It does not scan your laptop, read connected apps or copy university or agent credentials. You select source folders and imports, then approve a separate, limited sharing grant before an agent can read those saved versions.</p>
        <p className="mt-3 leading-7 text-slate-300">Real provider or university access requires your own login and a verified authorized read. Deleting local records can leave text in history and backups; revocation prevents future sharing but cannot recall content already sent to an agent.</p>
        <p className="mt-4 leading-7 text-slate-300">See the <a href={SETUP_GUIDE} className={linkStyle}>complete setup instructions</a> and <a href={`${LEARNBRIDGE_REPOSITORY}/blob/main/docs/design/IMPLEMENTATION_STATUS.md`} className={linkStyle}>current implementation evidence</a> for the capabilities and remaining integration gates in your checkout.</p>
      </section>
    </main>
  );
}
