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
      <body><nav className="border-b border-slate-800 bg-slate-950 px-6 py-4 flex flex-wrap items-center gap-6" aria-label="Main navigation"><a href="/" className="font-bold text-xl text-teal-300">LearnBridge</a><a href="/">Today</a><a href="/tutor">Tutor</a><a href="/workspace">Workspace</a><a href="/connections">Connections</a><AccountNav/></nav>{children}</body>
    </html>
  );
}

