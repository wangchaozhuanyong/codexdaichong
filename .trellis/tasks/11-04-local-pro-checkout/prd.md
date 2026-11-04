# Local Pro checkout repair

## Goal
Repair the installed local checkout flow after Pro 100 failed at 20 percent. The customer selected local execution and wants the repair validated through the existing payment-link debug page.

## Verified evidence
- Session bootstrap reached the Personal pricing page with Free and Plus and a visible See all plans link.
- The Pro 100 Checkout mapping is empty, so the API path failed before requesting a checkout.
- The UI fallback did not expand all plans and used generic Upgrade buttons for every Pro tier.
- The debug page accepted only a temporary mapping and refused UI fallback; real workers did not receive persistent local mappings.

## Requirements
- Keep Plus and the canonical Pro 100/200/500 tiers distinct. Never guess plan codes or silently select a different tier.
- Expand the all-plans pricing view and scope upgrade actions to the requested tier. Fail clearly when a tier is absent or ambiguous.
- Add persistent local checkout settings shared by debug and ordinary workers, separate from third-party provider mappings.
- Allow payment-link debug to use the same UI discovery when no API mapping is configured, but exit before entering the card/payment flow.
- Preserve the existing account, CDK, card, proxy and task data and unresolved manual-review hold.
- Verify with automated UI fixtures and the local admin/API. Live account checks may inspect pricing and create a checkout only; never fill cards, pay, solve a challenge, submit an activation, or clear the manual hold.
- Keep the third-party provider disabled as requested. Restart only after confirming no activation worker is running.

## Acceptance
- Regression cases cover hidden plans, wrong-plan buttons, multiple Pro tiers, missing/malformed local mappings and debug worker propagation.
- Existing tests pass, local settings round-trip and survive restart, and admin UI loads without script errors.
- Report separately whether a real Pro 100 checkout was verified or remains blocked by account eligibility/session/provider data.

## Implementation context
Codex uses inline dispatch by default in .trellis/config.yaml. Referenced trellis helper SKILL.md files are not present in this checkout or the installed skills; use the checked-in phase instructions and backend/frontend quality contracts directly.
