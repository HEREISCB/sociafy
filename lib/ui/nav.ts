/** The app's destinations, shared by the shell (components/shell.tsx) and the signed-in 404. */
export const NAV = [
  { href: '/dashboard', label: 'This week', icon: 'home' },
  { href: '/autopilot', label: 'Autopilot', icon: 'bolt' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
] as const;

export const ACCOUNT = [
  { href: '/account/billing', label: 'Billing & usage', icon: 'chart' },
  { href: '/account/api', label: 'API keys', icon: 'lock' },
] as const;

/** Pages that light up a nav item other than their own path (the billing tabs share one sidebar entry). */
export const ALSO_ACTIVE: Record<string, string[]> = {
  '/account/billing': ['/account/usage', '/account/invoices'],
};
