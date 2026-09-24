import { redirect } from 'next/navigation';

export default function ConnectionsRedirect() {
  redirect('/dashboard?tab=connections');
}
