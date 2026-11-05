# Select and verify Pro pricing tiers

The official Personal pricing dialog observed on 2026-11-05 shows Pro only after `查看所有套餐`. One Pro card shares `立即体验` across radio choices 100, 200, and 500. On the observed MYR account, those choices display RM420, RM999.90, and RM2,100 per month. Pro 100 Checkout independently shows the selected MYR420 Standard radio, `ChatGPT Pro`, and MYR420.00 due today.

- For canonical Pro tiers in the pricing UI path, switch to Personal, expand if needed, select the exact radio in the Pro card, and confirm its selected state before clicking its unique enabled action.
- Read the card's displayed monthly amount in the configured billing currency and match it against the selected Checkout option and total due before returning to the payment worker. Reject absent, ambiguous, or conflicting evidence.
- Keep the Plus, legacy, API, and payment submission paths outside this change. Do not hardcode regional prices or infer an API plan name.
- Verify offline with Chromium fixtures for all three tiers, competing CTAs, missing and nonselected tiers, and wrong Checkout tier, currency, or total. No card entry or payment in live verification.
