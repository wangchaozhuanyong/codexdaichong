# Complete checkout debugging without payment

## Authorized request
The user requests completing the existing checkout debug feature after observing that it stops on API errors and never exercises the pricing fallback.

## Required behavior
- Debug API failure in default API mode must continue into the existing pricing UI flow.
- API success must open the returned payment URL, not report success merely for generating a link.
- Both paths must pass a passive payment-page readiness check before success.
- Save and display a success screenshot as well as existing failure screenshots and logs.
- Debug must return before card allocation, field filling, submission, billing, or any payment function.
- Preserve formal activation behavior, credentials, plans, existing Plus button fix, proxy configuration, and business data.
- Do not submit live user Sessions or perform actual payments during verification.

## Acceptance
- Offline browser tests cover delayed/empty payment pages, login redirects, and a loaded payment form.
- Execute the actual worker phase in a VM with synthetic dependencies to cover API success, API rejection/UI fallback, UI failure, and explicit UI mode. Any payment call is forbidden in debug cases.
- Verify status parsing and UI success screenshot labels.
- Full test suite, syntax checks, local service restart, configuration/business row hashes unchanged.

## Workflow
Codex inline dispatch; no agents. Refer to checked-in backend guidelines; Trellis helper skills were unavailable in the previous scoped search. Backups are under ../local-deployment/update-backups/20261104-checkout-debug-page.
