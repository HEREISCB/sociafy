'use client';

/**
 * Loads Razorpay Standard Checkout once per browser session and opens a
 * modal from a `razorpay_modal` CheckoutHandoff. The component itself
 * renders nothing — call `openRazorpayModal(handoff, callbacks)` from a
 * click handler.
 */

type RazorpayHandoff = {
  kind: 'razorpay_modal';
  keyId: string;
  subscriptionId?: string;
  orderId?: string;
  amountMinor: number;
  currency: 'INR';
  description: string;
  prefill: { email?: string; name?: string };
  notes: Record<string, string>;
};

type RazorpayOptions = {
  key: string;
  amount?: number;
  currency: string;
  name: string;
  description?: string;
  subscription_id?: string;
  order_id?: string;
  prefill?: { email?: string; name?: string };
  notes?: Record<string, string>;
  handler?: (resp: { razorpay_payment_id: string }) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
};

type RazorpayInstance = { open: () => void };
type RazorpayConstructor = new (opts: RazorpayOptions) => RazorpayInstance;
declare global {
  interface Window { Razorpay?: RazorpayConstructor }
}

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Failed to load Razorpay script')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export async function openRazorpayModal(
  handoff: RazorpayHandoff,
  callbacks: { onSuccess?: () => void; onDismiss?: () => void } = {},
): Promise<void> {
  await loadRazorpayScript();
  const Razorpay = window.Razorpay!;
  const rzp = new Razorpay({
    key: handoff.keyId,
    amount: handoff.amountMinor,
    currency: handoff.currency,
    name: 'Sociafy',
    description: handoff.description,
    subscription_id: handoff.subscriptionId,
    order_id: handoff.orderId,
    prefill: handoff.prefill,
    notes: handoff.notes,
    handler: () => {
      callbacks.onSuccess?.();
      window.location.href = '/billing?checkout=success';
    },
    modal: { ondismiss: () => callbacks.onDismiss?.() },
    theme: { color: '#ff6b35' },
  });
  rzp.open();
}
