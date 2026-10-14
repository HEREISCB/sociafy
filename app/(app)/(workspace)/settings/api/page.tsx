import Link from 'next/link';
import { ApiKeys } from '../../../../../components/api-keys';

export default function SettingsApi() {
  return (
    <div className="usage-page">
      <ApiKeys />
      <p style={{ marginTop: 16 }}>
        <Link href="/developers/reference">API reference →</Link>
      </p>
    </div>
  );
}
