# Checkout API session repair with unchanged pricing fallback

## Approved requirements
- The user approved implementation on 2026-11-05 and explicitly requires other functions to remain unchanged.
- Production default MUST stay API attempt -> on any API session/request/page failure -> existing ChatGPT pricing UI -> existing payment flow.
- Limit changes to the API branch. Do not rewrite shared session-auth/bootstrap, proxy settings, card/payment/CDK logic, third-party recharge or pricing interactions.
- Fetch the real server session using context.request (not mocked page fetch), validate user identity and adopt the fresh token for Checkout only. Authentication errors stay inside the existing fallback catch.
- Preserve error text compatibility while adding bounded redacted diagnostics: phase, HTTP status, provider code/type/message, request ID, Retry-After, latency. A single 30-second checkout request, no automatic POST retries.
- Optional boolean api_only on the existing admin generate route defaults false; only debug workers can disable UI fallback. Existing admin UI defaults are unchanged.
- Add safe structured task markers and additive status fields so API success and UI fallback success are distinct. No database migration.
- Do not expose tokens, Cookie, complete sessions, proxy passwords or raw response dumps.

## Acceptance
- Offline tests: fresh token propagation; identity mismatch/invalid session produces zero checkout POSTs; all API failure categories preserve UI fallback; production reaches existing payment mock after successful fallback; debug never fills/submits payment.
- API-only debug stops without fallback and preserves structured failure. Explicit UI mode unchanged. Structured errors retain code/status/request IDs and redact credentials.
- Full existing test suite and syntax checks pass. Back up source, verify no active work before local restart, verify business table hashes unchanged and local UI/API health afterward.
- At most one live API-only link creation using an existing valid saved user session; no card/payment operations. If no usable session is available, report that limitation rather than replay stale credentials.
- No claim that remote unusual_activity is solved unless a real API-only request succeeds.

## Known evidence
Context.request shares cookies, proxy, UA and extra headers but does not run browser frontend logic. Two recorded API HTTP400 unusual_activity responses were followed by successful UI checkout. Shared auth code ignores fresh session and mocks later session checks; those global behaviors are explicitly deferred to preserve compatibility.
