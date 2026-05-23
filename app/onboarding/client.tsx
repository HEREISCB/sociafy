'use client';

import { useRouter } from 'next/navigation';
import Onboarding from '../../components/onboarding';

export default function OnboardingClient() {
  const router = useRouter();
  return <Onboarding onDone={() => router.push('/dashboard')} />;
}
