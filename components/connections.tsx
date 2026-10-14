'use client';

import React from 'react';
import ConnectionsList, { useOAuthReturn } from './connections-list';

const ConnectionsPage: React.FC = () => {
  const { flash, dismiss } = useOAuthReturn();
  return (
    <>
      {/* The settings layout owns the page <h1>; this is the section header. */}
      <header className="conn-head">
        <h2>Connections</h2>
        <p>The accounts Sociafy posts to.</p>
      </header>
      <ConnectionsList mode="manage" next="/settings/connections" flash={flash} onDismissFlash={dismiss} />
      <p className="conn-support">
        Trouble connecting? Email <a href="mailto:support@sociafy.app">support@sociafy.app</a>.
      </p>
    </>
  );
};

export default ConnectionsPage;
