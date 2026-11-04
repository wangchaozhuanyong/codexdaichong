# Plus pricing button compatibility

## Authorized scope
- The user requested fixing Plus button recognition and updating to the latest upstream.
- Upstream main is a74f5cc53d7d50bfff003abae515c91a5721ff72 (2026-11-02); no release or newer commit was available on 2026-11-04.
- Existing local tracked contents already match that upstream baseline.

## Requirements
- Recognize the observed Plus card titled `Plus` with its `Start now` button.
- Recognize that pricing surface as Personal without unnecessary tab switching.
- Scope the new button match to the Plus card; never select Free, Pro, Business, or unrelated Start now buttons.
- Preserve existing Upgrade/Get Plus/Subscribe button paths and all payment, plan, proxy, and Session behavior.
- Back up code and the local database before applying the patch.
- Run offline browser regression checks, existing tests, syntax checks, and a local-service restart/health check.
- Do not submit a real Checkout, registration, or payment task.

## Evidence
- Task 11 reached the Personal pricing page but failed to find the Plus button.
- Saved screenshot: debug_screenshots/activation/error_1793790397650.png.
- Current pricing-checkout.js only recognizes Upgrade/Get/Subscribe labels.
- Separate Checkout HTTP 400 unusual-activity failures are outside this change.

## Workflow notes
- Codex dispatch defaults to inline; no sub-agents.
- Trellis helper skills were searched under local Codex/Agents/Cursor skill directories and are unavailable. Follow the checked-in workflow and backend guidelines directly.
- Acceptance is offline button behavior plus local deployment health, not a claim of successful real payment.
