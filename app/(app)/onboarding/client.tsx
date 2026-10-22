'use client';

import { useRouter } from 'next/navigation';
import Onboarding from '../../../components/onboarding';
import { ToastProvider } from '../../../components/ui';

export default function OnboardingClient() {
  const router = useRouter();
  // Onboarding sits outside the workspace layout, so it mounts its own toast host.
  return <ToastProvider><Onboarding onDone={() => router.push('/dashboard')} /></ToastProvider>;
}
