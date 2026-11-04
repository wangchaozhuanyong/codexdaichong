# Validation and live-account limit

- Playwright locator guidance: https://playwright.dev/docs/locators (read 2026-11-04). Scope actions to a uniquely identified card; do not use a generic first Upgrade button.
- Full suite: 12 files and 156 tests passed, including native Chromium fixtures for collapsed pricing, exact canonical tiers, ambiguous/missing cards, duplicate cards and split USD price spans.
- Syntax and whitespace checks passed for changed JavaScript and the working diff.
- The running local admin API accepts validated local checkout settings and returns the same mappings to the debug page. Settings persisted over application/database restart. Unauthenticated access is rejected.
- Local UI login, new settings panel and Pro 100 debug selection passed without JavaScript errors.
- Existing CDKs, cards, proxies, manual holds, tasks and billing matched their pre-restart row hashes. Third-party provider remains disabled.
- A read-only attempt using the existing application session and saved proxy failed with ERR_TUNNEL_CONNECTION_FAILED. A second attempt using a freshly retrieved proxy reached session verification but returned HTTP 403 with no accepted user session. No CAPTCHA was solved, no checkout/payment was submitted, and the manual hold was not cleared.
- Real Pro 100 checkout creation is not verified. The user was asked to refresh Session in the local debug page and run the no-payment action; credentials must not be sent in chat.
