---
title: Use Injection Tokens for Interfaces
impact: HIGH
impactDescription: Enables interface-based DI at runtime
tags: dependency-injection, tokens, interfaces
---

## Use Injection Tokens for Interfaces

TypeScript interfaces are erased at compile time and can't be used as injection tokens. Use string tokens, symbols, or abstract classes when you want to inject implementations of interfaces. The token is also the seam tests replace: the module always registers the production implementation, and a test overrides the token.

**Incorrect (interface can't be used as token):**

```typescript
// Interface can't be used as injection token
interface PaymentGateway {
  charge(input: ChargeInput): Promise<Charge>;
}

@Injectable()
export class StripeService implements PaymentGateway { /* ... */ }

@Injectable()
export class OrdersService {
  // This WON'T work - PaymentGateway doesn't exist at runtime
  constructor(private payment: PaymentGateway) {}
}
```

**Correct (symbol tokens or abstract classes):**

```typescript
// Option 1: String/Symbol tokens (most flexible)
// payments/payment-gateway.ts: the contract and StripeService are in di-liskov-substitution
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface PaymentGateway {
  charge(input: ChargeInput): Promise<Charge>;
  refund(chargeId: string, amount?: number): Promise<Refund>;
}

// Module registration: always the production implementation
@Module({
  providers: [{ provide: PAYMENT_GATEWAY, useClass: StripeService }],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentModule {}

// Injection
@Injectable()
export class CheckoutService {
  constructor(@Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway) {}
}

// test/checkout.e2e-spec.ts: the test replaces the token, the module graph stays production
const gateway = { charge: vi.fn(async ({ orderId, amount }: ChargeInput) => ({ chargeId: `ch_${orderId}`, amount })) };
app = await createTestApp((builder) => builder.overrideProvider(PAYMENT_GATEWAY).useValue(gateway));

// Option 2: Abstract class (carries runtime type info)
export abstract class PaymentGateway {
  abstract charge(input: ChargeInput): Promise<Charge>;
  abstract refund(chargeId: string, amount?: number): Promise<Refund>;
}

// StripeService then `extends PaymentGateway` instead of `implements` it
// providers: [{ provide: PaymentGateway, useClass: StripeService }]
// No @Inject needed with abstract class
@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentGateway) {}
}
```

A `process.env.NODE_ENV === 'test' ? Mock : Real` switch puts test code in the production graph, reads the environment behind `ConfigService`'s back, and leaves the e2e suite testing a module graph production never runs. Replace the token per suite instead; with the override above, the probe's checkout suite charged through `gateway` while every other provider stayed real. When a deployment genuinely selects an implementation (two payment providers), pick it in a `useFactory` that reads a validated setting with `config.getOrThrow()`, never a test double. Test structure: `nestjs-testing` (`e2e-real-app-module`).

Reference: [NestJS Custom Providers](https://docs.nestjs.com/fundamentals/custom-providers)
