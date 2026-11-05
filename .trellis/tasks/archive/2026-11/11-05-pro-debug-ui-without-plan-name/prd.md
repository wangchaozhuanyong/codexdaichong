# Allow Pro debug without an API plan name

The normal admin checkout debug route resolved an API plan name before creating a task. For canonical Pro tiers with no known mapping this blocked the proven pricing UI flow before the browser launched.

- With no mapping or nonblank override, normal admin debug starts a UI-only worker. It preserves the exact selected plan and region, and uses the existing no-payment debug stop.
- API-only mode requires a resolved name and returns a clear 400 before creating a task. Existing Plus and explicitly configured API paths keep their previous behavior.
- The debug form explains that the API field is optional for UI debug. Do not invent plan IDs or change formal activation, payment, or external API behavior.
- Validate route selection and worker environment with synthetic input; no real checkout, card entry, or payment is needed for this regression.
