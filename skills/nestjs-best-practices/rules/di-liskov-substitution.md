---
title: Honor Liskov Substitution Principle
impact: HIGH
impactDescription: Ensures implementations are truly interchangeable without breaking callers
tags: dependency-injection, inheritance, solid, lsp
---

## Honor Liskov Substitution Principle

Subtypes must be substitutable for their base types without altering program correctness. In NestJS with dependency injection, this means any implementation of an interface or abstract class must honor the contract completely. A mock payment service used in tests must behave like a real payment service (return similar shapes, handle errors the same way). Violating LSP causes subtle bugs when swapping implementations.

**Incorrect (implementations break the contract):**

```typescript
// Production implementation: no idempotency key, so a retried charge for the same order charges twice
@Injectable()
export class StripeService implements PaymentGateway {
  async charge({ amount, currency }: ChargeInput): Promise<Charge> {
    const response = await this.stripe.charges.create({ amount, currency });
    return { chargeId: response.id, amount };
  }
}

// Mock that violates LSP - different behavior!
@Injectable()
export class MockPaymentService implements PaymentGateway {
  async charge({ amount, currency }: ChargeInput): Promise<Charge> {
    // VIOLATION 1: Throws for valid input
    if (amount > 1000) {
      throw new Error('Mock does not support large amounts');
    }

    // VIOLATION 2: Returns null instead of a Charge
    if (currency !== 'usd') {
      return null as any; // Real service would convert or reject properly
    }

    // VIOLATION 3: Missing required field, and a new charge on every call for the same order
    return { amount } as Charge;
  }
}
```

**Correct (one documented contract; every implementation honors it):**

```typescript
// payments/payment-gateway.ts
export interface ChargeInput {
  orderId: string;
  /** Smallest currency unit (cents). */
  amount: number;
  /** ISO 4217, lower case as Stripe uses it. */
  currency: string;
}

export interface Charge {
  chargeId: string;
  amount: number;
}

export interface Refund {
  refundId: string;
  amount: number;
}

export interface PaymentGateway {
  /**
   * Charges at most once per orderId: a repeated orderId returns the first charge.
   * @throws PaymentFailedException if the charge is declined
   * @throws InvalidCurrencyException if the currency is not supported
   */
  charge(input: ChargeInput): Promise<Charge>;

  /** @throws TransactionNotFoundException if chargeId is unknown */
  refund(chargeId: string, amount?: number): Promise<Refund>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
```

```typescript
// payments/stripe.service.ts
import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

// Production implementation: the provider errors the contract names become its domain exceptions
@Injectable()
export class StripeService implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async charge({ orderId, amount, currency }: ChargeInput): Promise<Charge> {
    try {
      // orderId is the idempotency key: Stripe answers a repeated key with the first request's result
      const charge = await this.stripe.charges.create({ amount, currency, metadata: { orderId } }, { idempotencyKey: orderId });
      return { chargeId: charge.id, amount: charge.amount };
    } catch (error) {
      // `error` is unknown: narrow with the SDK's classes before reading any property
      if (error instanceof Stripe.errors.StripeCardError) {
        throw new PaymentFailedException(error.message);
      }
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.param === 'currency') {
        throw new InvalidCurrencyException(`Unsupported currency: ${currency}`);
      }
      throw error; // network, auth and rate-limit errors are not part of the contract
    }
  }

  async refund(chargeId: string, amount?: number): Promise<Refund> {
    try {
      const refund = await this.stripe.refunds.create({ charge: chargeId, amount });
      return { refundId: refund.id, amount: refund.amount };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        throw new TransactionNotFoundException(chargeId);
      }
      throw error;
    }
  }
}
```

```typescript
// payments/mock-payment.service.ts
// Mock that honors LSP: same contract, same failure modes, same idempotency
@Injectable()
export class MockPaymentService implements PaymentGateway {
  private readonly charges = new Map<string, Charge>(); // by orderId, like the idempotency key

  async charge({ orderId, amount, currency }: ChargeInput): Promise<Charge> {
    if (!['usd', 'eur', 'gbp'].includes(currency)) {
      throw new InvalidCurrencyException(`Unsupported currency: ${currency}`);
    }
    if (amount === 99999) {
      throw new PaymentFailedException('Card declined (test scenario)');
    }
    const existing = this.charges.get(orderId);
    if (existing) return existing;

    const charge: Charge = { chargeId: `mock_ch_${this.charges.size + 1}`, amount };
    this.charges.set(orderId, charge);
    return charge;
  }

  async refund(chargeId: string, amount?: number): Promise<Refund> {
    const charge = [...this.charges.values()].find((c) => c.chargeId === chargeId);
    if (!charge) {
      throw new TransactionNotFoundException(chargeId);
    }
    return { refundId: `refund_${chargeId}`, amount: amount ?? charge.amount };
  }
}
```

**Testing LSP compliance:**

```typescript
// test/payment-gateway.contract.ts: the suite every implementation must pass
import { randomUUID } from 'node:crypto';

export function testPaymentGatewayContract(createGateway: () => PaymentGateway) {
  describe('PaymentGateway contract', () => {
    let gateway: PaymentGateway;

    beforeEach(() => {
      gateway = createGateway();
    });

    it('returns a charge with an id and the amount', async () => {
      const charge = await gateway.charge({ orderId: randomUUID(), amount: 1000, currency: 'usd' });
      expect(charge).toEqual({ chargeId: expect.any(String), amount: 1000 });
    });

    it('returns the first charge for a repeated orderId', async () => {
      const input = { orderId: randomUUID(), amount: 1000, currency: 'usd' };
      const first = await gateway.charge(input);
      await expect(gateway.charge(input)).resolves.toEqual(first);
    });

    it('throws InvalidCurrencyException for an unsupported currency', async () => {
      await expect(gateway.charge({ orderId: randomUUID(), amount: 1000, currency: 'xxx' })).rejects.toThrow(InvalidCurrencyException);
    });

    it('throws TransactionNotFoundException for an unknown refund', async () => {
      await expect(gateway.refund('ch_nonexistent')).rejects.toThrow(TransactionNotFoundException);
    });
  });
}

// test/payments.e2e-spec.ts
describe('MockPaymentService', () => {
  testPaymentGatewayContract(() => new MockPaymentService());
});

// Stripe test mode: needs network and a test key
describe.skipIf(!process.env.STRIPE_TEST_KEY)('StripeService', () => {
  testPaymentGatewayContract(() => new StripeService(new Stripe(process.env.STRIPE_TEST_KEY ?? '')));
});
```

`CheckoutService` in `arch-single-responsibility` is the consumer: it charges with the order's id and works unchanged with either implementation. Stripe keeps an idempotency key for at least 24 hours and answers a repeat with the first result. Under `strict`, a `catch` variable is `unknown`, so `error.type === 'card_error'` fails with `TS18046: 'error' is of type 'unknown'`. In the probe (`stripe` 23.0.1, a fake `fetch` behind `Stripe.createFetchHttpClient()`), two charges for `ord_1` both sent `Idempotency-Key: ord_1`, where the old `charges.create({ amount, currency })` sent a fresh `stripe-node-retry-<uuid>` per call. A card decline became `PaymentFailedException: Your card was declined.`, `param: 'currency'` became `InvalidCurrencyException`, `resource_missing` on refund became `TransactionNotFoundException`, and a `StripeConnectionError` or a thrown string came out unchanged. `MockPaymentService` passed the contract suite; the Stripe suite is skipped without `STRIPE_TEST_KEY`.

Reference: [Liskov Substitution Principle](https://en.wikipedia.org/wiki/Liskov_substitution_principle), [Stripe Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
