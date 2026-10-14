'use client';

import Link from 'next/link';
import { ApiKeys, DEFAULT_CAP } from '../../../../../components/api-keys';

export default function SettingsApi() {
  return (
    <>
      <p className="settings-intro">
        Keys call the Sociafy API and spend this account&apos;s credits, up to a daily cap per key
        (default {DEFAULT_CAP.toLocaleString()}). <Link href="/developers/reference">API reference</Link>
      </p>
      <ApiKeys />
    </>
  );
}
