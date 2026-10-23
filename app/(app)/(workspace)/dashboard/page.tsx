import { Suspense } from 'react';
import Dashboard from '../../../../components/dashboard';

export const metadata = { title: 'This week' };

// Home is the planning session: review the coming week or month, approve, leave.
// Suspense: Dashboard reads ?post= (the phone's review screen) with useSearchParams.
export default function HomePage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}
