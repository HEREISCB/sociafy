'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** Shows the app frame when Clerk's client cookie says a session exists (UI choice only, not auth). */
export function NotFoundFrame({ publicFrame, appFrame }: { publicFrame: ReactNode; appFrame: ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reads a cookie after hydration
  useEffect(() => setSignedIn(/(?:^|;\s*)__client_uat(?:_[^=]+)?=[1-9]/.test(document.cookie)), []);
  return <>{signedIn ? appFrame : publicFrame}</>;
}
