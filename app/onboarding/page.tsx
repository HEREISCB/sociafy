'use client';

import { useRouter } from 'next/navigation';
import Onboarding from '../../components/onboarding';

export default function OnboardingPage() {
  const router = useRouter();
  return <Onboarding onDone={() => router.push('/dashboard')} />;
}
