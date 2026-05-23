import Razorpay from 'razorpay';
import { env } from '../../../env';

let _client: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (_client) return _client;
  if (!env.razorpay.keyId || !env.razorpay.keySecret) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET is not set');
  }
  _client = new Razorpay({
    key_id: env.razorpay.keyId,
    key_secret: env.razorpay.keySecret,
  });
  return _client;
}

export function razorpayPlanIdFor(tier: 'starter' | 'pro' | 'business'): string | null {
  switch (tier) {
    case 'starter':  return env.razorpay.planStarter;
    case 'pro':      return env.razorpay.planPro;
    case 'business': return env.razorpay.planBusiness;
  }
}
