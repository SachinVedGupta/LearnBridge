import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth';
import EmailOnboarding from './email-onboarding-client';

export const dynamic = 'force-dynamic';
export default async function EmailOnboardingPage() {
  try { await requireUser(); } catch { redirect('/login'); }
  return <EmailOnboarding />;
}
