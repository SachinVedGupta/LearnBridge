import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth';
import CloudOnboarding from './cloud-onboarding-client';

export const dynamic = 'force-dynamic';
export default async function CloudOnboardingPage() {
  try { await requireUser(); } catch { redirect('/login'); }
  return <CloudOnboarding />;
}
