import type { BillingProvider } from '../../provider';

class StubRazorpayProvider {
  readonly name = 'razorpay' as const;
  readonly currency = 'INR' as const;
  async startSubscription(): Promise<never> { throw new Error('not implemented yet — see Task 13'); }
  async startTopUp(): Promise<never>        { throw new Error('not implemented yet — see Task 14'); }
  async cancelSubscription(): Promise<never> { throw new Error('not implemented yet — see Task 15'); }
  async changeTier(): Promise<never>        { throw new Error('not implemented yet — see Task 16'); }
}

let _instance: StubRazorpayProvider | null = null;
export function razorpayProvider(): BillingProvider {
  if (!_instance) _instance = new StubRazorpayProvider();
  return _instance as unknown as BillingProvider;
}
