'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sanitizeCheckoutDiagnostic } = require('../checkout-api-diagnostic');
const { requireCanonicalPlanType, getPlanDefinition, getPlanLabel } = require('../plan-registry');
const { isSupportedRegion } = require('../region-config');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function extract(startMarker, endMarker) {
    const start = serverSource.indexOf(startMarker);
    const end = serverSource.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error(`Missing source boundary: ${startMarker}`);
    return serverSource.slice(start, end);
}

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function metadataParser() {
    const sandbox = vm.createContext({ sanitizeCheckoutDiagnostic });
    vm.runInContext(extract('function extractCheckoutApiMetadata(', 'function analyzeCheckoutDebugOutput(')
        + '\nthis.parse = extractCheckoutApiMetadata;', sandbox);
    return sandbox.parse;
}

describe('Checkout diagnostic metadata', () => {
    it('keeps historical output unknown rather than guessing API success', () => {
        expect(metadataParser()('CHECKOUT_PAGE_READY\nCHECKOUT_DEBUG_SUCCESS')).toEqual({
            api_outcome: 'unknown', checkout_source: 'unknown', diagnostic: null
        });
    });

    it('distinguishes API rejection from a later successful pricing fallback', () => {
        const data = metadataParser()('CHECKOUT_API_RESULT: ' + JSON.stringify({ outcome: 'failed',
            diagnostic: { phase: 'checkout-create', httpStatus: 400, code: 'unusual_activity',
                requestId: 'request-123', retryAfter: '60', message: 'Please try again later.' } })
            + '\nCHECKOUT_SOURCE: ui\nCHECKOUT_DEBUG_SUCCESS');
        expect(data.api_outcome).toBe('failed');
        expect(data.checkout_source).toBe('ui');
        expect(data.diagnostic).toMatchObject({ httpStatus: 400, code: 'unusual_activity',
            requestId: 'request-123', retryAfter: '60' });
    });

    it('ignores malformed, oversized and invalid outcome/source markers', () => {
        const parse = metadataParser();
        expect(parse('CHECKOUT_API_RESULT: {bad}\nCHECKOUT_API_RESULT: '
            + JSON.stringify({ outcome: 'success', message: 'x'.repeat(5000) })
            + '\nCHECKOUT_API_RESULT: {"outcome":"unknown"}\nCHECKOUT_SOURCE: external')).toEqual({
            api_outcome: 'unknown', checkout_source: 'unknown', diagnostic: null
        });
    });

    it('passes diagnostics through an allowlist and redacts scalar credentials again', () => {
        const data = metadataParser()('CHECKOUT_API_RESULT: ' + JSON.stringify({ outcome: 'failed',
            accessToken: 'secret-at-root', diagnostic: { phase: 'checkout-create',
                message: 'Cookie: session-token=cookie-secret', code: 'synthetic_code',
                accessToken: 'secret-token', raw: { cookies: 'secret-cookie' },
                requestId: { secret: 'object-secret' }, latencyMs: -30 } }));
        const json = JSON.stringify(data);
        for (const secret of ['secret-at-root', 'cookie-secret', 'secret-token', 'secret-cookie', 'object-secret']) {
            expect(json).not.toContain(secret);
        }
        expect(data.diagnostic.code).toBe('synthetic_code');
        expect(Object.keys(data.diagnostic).sort()).toEqual([
            'phase', 'httpStatus', 'code', 'type', 'message', 'requestId', 'retryAfter', 'latencyMs'
        ].sort());
    });
});

function generateRouteHarness() {
    const spawned = [];
    const created = [];
    let handler;
    const sandbox = vm.createContext({
        app: { post: (_route, callback) => { handler = callback; } },
        ensureStoreReady: async () => {},
        parseSessionJson: (raw) => JSON.parse(raw), normalizeSessionToken: () => 'synthetic-token',
        validateAccessToken: () => ({ valid: true }), requireCanonicalPlanType, getPlanDefinition, getPlanLabel, isSupportedRegion,
        buildStoredSessionPayload: (raw) => raw, extractEmailFromSession: () => 'synthetic@example.com',
        extractSessionPreview: () => 'synthetic', logTask: () => {},
        spawnCheckoutDebugWorker: (input) => spawned.push(input),
        store: {
            getPaymentRegion: async () => 'PH',
            createTaskLog: async (input) => { created.push(input); return { jobKey: 'synthetic-job' }; },
            updateTaskLog: async () => {}
        }
    });
    vm.runInContext(extract("app.post('/api/admin/checkout/generate'", "app.get('/api/admin/checkout/status/:jobKey'"), sandbox);
    return { spawned, created, run: async (extra = {}) => {
        const response = createResponse();
        await handler({ body: { session: '{"accessToken":"synthetic-token"}', ...extra } }, response);
        return response;
    } };
}

describe('existing admin generate route compatibility', () => {
    it.each([undefined, false, true])('accepts optional api_only=%s and preserves the old response', async (apiOnly) => {
        const harness = generateRouteHarness();
        const response = await harness.run(apiOnly === undefined ? {} : { api_only: apiOnly });
        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ success: true, jobKey: 'synthetic-job' });
        expect(harness.spawned).toHaveLength(1);
        expect(harness.spawned[0].apiOnly).toBe(apiOnly === true);
        expect(harness.spawned[0]).toMatchObject({ checkoutMode: 'api', planNameOverride: 'chatgptplusplan' });
        expect(harness.created[0].cdkCode).toBe('[checkout-debug]');
    });

    it.each(['true', 'false', 1, null, {}])('rejects nonboolean api_only=%j without creating a task', async (value) => {
        const harness = generateRouteHarness();
        const response = await harness.run({ api_only: value });
        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain('api_only');
        expect(harness.spawned).toHaveLength(0);
        expect(harness.created).toHaveLength(0);
    });

    it.each(['pro100', 'pro200', 'pro500'])('starts %s pricing UI when the API name is blank', async (planType) => {
        const harness = generateRouteHarness();
        const response = await harness.run({ plan_type: planType, plan_name: '   ', country: 'MY' });
        expect(response.statusCode).toBe(200);
        expect(harness.spawned).toEqual([expect.objectContaining({ planType, region: 'MY', checkoutMode: 'ui',
            apiOnly: false, planNameOverride: '' })]);
    });

    it('rejects a missing API-only plan name before creating a task', async () => {
        const harness = generateRouteHarness();
        const response = await harness.run({ plan_type: 'pro100', api_only: true });
        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain('plan_name');
        expect(harness.created).toHaveLength(0);
        expect(harness.spawned).toHaveLength(0);
    });

    it('keeps a nonblank manual override on the API path', async () => {
        const harness = generateRouteHarness();
        const response = await harness.run({ plan_type: 'pro100', plan_name: ' synthetic-pro ', api_only: true });
        expect(response.statusCode).toBe(200);
        expect(harness.spawned[0]).toMatchObject({ checkoutMode: 'api', planNameOverride: 'synthetic-pro', apiOnly: true });
    });
});

describe('existing admin status response compatibility', () => {
    it('retains existing status fields and adds safe API/source metadata', async () => {
        let handler;
        const parseMetadata = metadataParser();
        const output = 'CHECKOUT_API_RESULT: {"outcome":"failed","diagnostic":{"httpStatus":400,"code":"unusual_activity"}}'
            + '\nCHECKOUT_SOURCE: ui\nCHECKOUT_URL: https://chatgpt.com/checkout/openai_llc/synthetic\nCHECKOUT_PAGE_READY';
        const sandbox = vm.createContext({
            app: { get: (_route, callback) => { handler = callback; } },
            ensureStoreReady: async () => {},
            store: { getTaskStatus: async () => ({ status: 'success', message: 'Existing message',
                progress: 100, raw_output: output, failure_screenshots: '["ready.png"]' }) },
            extractCheckoutUrlFromOutput: () => 'https://chatgpt.com/checkout/openai_llc/synthetic',
            extractScreenshotsFromOutput: () => [], extractVideosFromOutput: () => [],
            extractCheckoutApiMetadata: parseMetadata
        });
        vm.runInContext(extract("app.get('/api/admin/checkout/status/:jobKey'", '// ─── Card Pool Management API'), sandbox);
        const response = createResponse();
        await handler({ params: { jobKey: 'synthetic-job' } }, response);
        expect(response.body).toMatchObject({ success: true, jobKey: 'synthetic-job', status: 'success',
            message: 'Existing message', progress: 100, checkout_page_ready: true, screenshots: ['ready.png'],
            videos: [], api_outcome: 'failed', checkout_source: 'ui', diagnostic: { httpStatus: 400 } });
    });
});

describe('debug worker environment isolation', () => {
    it.each([[undefined, undefined], [false, 'api'], [true, 'api'], [false, 'ui']])(
        'sets api_only=%s and mode=%s explicitly rather than inheriting parent flags', async (apiOnly, checkoutMode) => {
        let finish;
        const done = new Promise((resolve) => { finish = resolve; });
        const captured = [];
        const sandbox = vm.createContext({
            path, __dirname: path.join(__dirname, '..'),
            process: { env: { CHECKOUT_API_ONLY: '1', CHECKOUT_MODE: 'other' } }, console: { error: () => {} },
            store: { getActiveProxy: async () => '', getHcaptchaConfig: async () => ({}),
                updateTaskLog: async (_key, value) => { if (value.status !== 'running') finish(value); } },
            buildHcaptchaEnvFromConfig: () => ({ env: {} }), logTask: () => {},
            spawnWorkerWithBrowser: async ({ runtimeEnv }) => { captured.push(runtimeEnv); return { output: '', timedOut: false }; },
            analyzeCheckoutDebugOutput: () => ({ status: 'success', checkoutPageReady: true }),
            extractCheckoutUrlFromOutput: () => 'https://chatgpt.com/checkout/openai_llc/synthetic',
            extractScreenshotsFromOutput: () => [], getCheckoutProgress: () => 100
        });
        vm.runInContext(extract('function spawnCheckoutDebugWorker(', 'const LEGACY_GPT_API_PLAN_MAP')
            + '\nthis.spawn = spawnCheckoutDebugWorker;', sandbox);
        const args = { task: { jobKey: 'synthetic-job' }, token: 'synthetic-token', sessionRaw: '{}',
            planType: 'plus', region: 'PH', email: 'synthetic@example.com' };
        if (apiOnly !== undefined) args.apiOnly = apiOnly;
        if (checkoutMode !== undefined) args.checkoutMode = checkoutMode;
        sandbox.spawn(args);
        expect((await done).status).toBe('success');
        expect(captured).toHaveLength(1);
        expect(captured[0]).toMatchObject({ CHECKOUT_DEBUG_ONLY: '1', CHECKOUT_MODE: checkoutMode || 'api',
            CHECKOUT_API_ONLY: apiOnly === true ? '1' : '0' });
    });
});
