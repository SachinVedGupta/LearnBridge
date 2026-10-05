import type { Metadata } from 'next';
import './globals.css';
import AccountNav from '@/components/AccountNav';

export const metadata: Metadata = {
  title: 'LearnBridge',
  description: 'Your courses, plans and learning in one place',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body><nav className="border-b border-slate-800 bg-slate-950 px-6 py-4 flex flex-wrap items-center gap-6" aria-label="Main navigation"><a href="/" className="font-bold text-xl text-teal-300">LearnBridge</a><a href="/">Today</a><a href="/tutor">Tutor</a><a href="/workspace">Workspace</a><a href="/connections">Connections</a><a href="/onboarding/cloud">Import cloud sources</a><a href="/onboarding/email">Import selected emails</a><a href="/remote">Phone companion</a><a href="/setup">Local setup</a><AccountNav/></nav>{children}<footer className="border-t border-slate-800 px-6 py-6 text-sm text-slate-400"><div className="mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-2"><a className="hover:text-teal-300" href="/privacy">Privacy</a><a className="hover:text-teal-300" href="/terms">Terms</a><a className="hover:text-teal-300" href="mailto:sachinvgupta9@gmail.com">Contact</a></div></footer></body>
    </html>
  );
}
