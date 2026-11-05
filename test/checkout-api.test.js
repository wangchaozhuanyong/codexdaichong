'use strict';

const http = require('http');
const { chromium } = require('playwright');
const ChatGPTService = require('../chatgpt');
const { openApiCheckout } = ChatGPTService;
const { SESSION_TIMEOUT_MS } = require('../checkout-api-session');
const { sanitizeCheckoutDiagnostic } = require('../checkout-api-diagnostic');

function jwt({ userId = 'user_same', email = 'same@example.test', exp = Math.floor(Date.now() / 1000) + 3600,
    accountId = 'workspace_a' } = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ typ: 'JWT', alg: 'RS256' })}.${encode({ exp,
        'https://api.openai.com/auth': { chatgpt_user_id: userId, chatgpt_account_id: accountId },
        'https://api.openai.com/profile': { email } })}.synthetic-signature`;
}

function reply(status, data, headers = {}) {
    return { status: () => status, text: async () => typeof data === 'string' ? data : JSON.stringify(data),
        headers: () => headers };
}

function harness({ session = { user: { id: 'user_same', email: 'same@example.test' }, accessToken: jwt() },
    sessionStatus = 200, checkoutStatus = 200,
    checkoutBody = { checkout_session_id: 'oaics_synthetic' }, headers = {} } = {}) {
    const calls = [];
    const request = {
        get: async (url, options) => { calls.push({ method: 'GET', url, options }); return reply(sessionStatus, session); },
        post: async (url, options) => { calls.push({ method: 'POST', url, options }); return reply(checkoutStatus, checkoutBody, headers); }
    };
    return { request, calls, page: { context: () => ({ request }) } };
}

const OLD_TOKEN = jwt({ exp: Math.floor(Date.now() / 1000) - 60 });
const OPTIONS = { accessToken: OLD_TOKEN,
    sessionData: { user: { id: 'user_same', email: 'same@example.test' }, accessToken: OLD_TOKEN },
    planType: 'plus', country: 'PH', currency: 'PHP', verifyPage: false };

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('checkout API branch reads a fresh real session', () => {
    it('sends only the fresh token without altering the imported session or shared context', async () => {
        const fresh = jwt({ accountId: 'workspace_b' });
        const h = harness({ session: { user: { id: 'user_same' }, accessToken: fresh } });
        const input = JSON.parse(JSON.stringify(OPTIONS));
        const before = JSON.stringify(input);
        const result = await openApiCheckout(h.page, input);
        expect(h.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
        expect(h.calls[0].options).toMatchObject({ timeout: SESSION_TIMEOUT_MS, maxRetries: 0, maxRedirects: 0 });
        expect(h.calls[0].options.headers.Authorization).toBeUndefined();
        expect(h.calls[1].options.headers.Authorization).toBe(`Bearer ${fresh}`);
        expect(h.calls[1].options).toMatchObject({ timeout: 30000, maxRetries: 0, maxRedirects: 0 });
        expect(h.calls[1].options.data).toMatchObject({ plan_name: 'chatgptplusplan', billing_details: { country: 'PH', currency: 'PHP' } });
        expect(result.checkoutUrl).toContain('oaics_synthetic');
        expect(result.diagnostic.httpStatus).toBe(200);
        expect(JSON.stringify(input)).toBe(before);
    });

    it.each([
        ['Cookie user differs', { user: { id: 'user_other' }, accessToken: jwt({ userId: 'user_other' }) }, 200, 'SESSION_IDENTITY_MISMATCH'],
        ['fresh token belongs to another user', { user: { id: 'user_same' }, accessToken: jwt({ userId: 'user_other' }) }, 200, 'SESSION_IDENTITY_MISMATCH'],
        ['missing server user', { accessToken: jwt() }, 200, 'SESSION_INVALID'],
        ['missing server token', { user: { id: 'user_same' } }, 200, 'SESSION_TOKEN_INVALID'],
        ['expired fresh token', { user: { id: 'user_same' }, accessToken: OLD_TOKEN }, 200, 'SESSION_TOKEN_EXPIRED'],
        ['JWT without expiry', { user: { id: 'user_same' }, accessToken: jwt({ exp: null }) }, 200, 'SESSION_TOKEN_INVALID'],
        ['expired server session', { user: { id: 'user_same' }, accessToken: jwt(), expires: '2000-01-01T00:00:00.000Z' }, 200, 'SESSION_TOKEN_EXPIRED'],
        ['empty JSON', {}, 200, 'SESSION_INVALID'],
        ['non JSON', '<html>login</html>', 200, 'SESSION_INVALID'],
        ['unauthorized', {}, 401, 'SESSION_HTTP_ERROR'],
        ['redirect', {}, 302, 'SESSION_HTTP_ERROR']
    ])('%s blocks checkout creation', async (_label, session, sessionStatus, code) => {
        const h = harness({ session, sessionStatus });
        await expect(openApiCheckout(h.page, OPTIONS)).rejects.toMatchObject({ diagnostic: { phase: 'session-check', code } });
        expect(h.calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('compares email only when there is no pair of comparable user IDs', async () => {
        const h = harness({ session: { user: { email: 'SAME@example.test' }, accessToken: 'synthetic-opaque-token' } });
        const result = await openApiCheckout(h.page, OPTIONS);
        expect(result.checkoutUrl).toContain('oaics_synthetic');
        expect(h.calls[1].options.headers.Authorization).toBe('Bearer synthetic-opaque-token');
    });

    it('does not accept unverified input identity or a workspace as user identity', async () => {
        const h = harness();
        await expect(openApiCheckout(h.page, { ...OPTIONS, accessToken: 'synthetic-token',
            sessionData: { account: { id: 'workspace_a' } } })).rejects.toMatchObject({
            diagnostic: { code: 'SESSION_IDENTITY_UNVERIFIED' }
        });
        expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });

    it('redacts session transport errors and never starts a checkout POST', async () => {
        const h = harness();
        h.request.get = async () => { throw new Error(`Timeout 15000ms\nAuthorization: Bearer ${OLD_TOKEN}\nCookie: secret_cookie=secret-value`); };
        let caught;
        try { await openApiCheckout(h.page, OPTIONS); } catch (error) { caught = error; }
        expect(caught.diagnostic).toMatchObject({ phase: 'session-check', code: 'SESSION_TIMEOUT', httpStatus: null });
        expect(JSON.stringify(caught.diagnostic) + caught.message).not.toMatch(/secret-value|synthetic-signature/);
        expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });

    it('marks page failure as created so API success is not confused with page readiness', async () => {
        const h = harness({ checkoutBody: { checkout_session_id: 'oaics_synthetic',
            url: 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic?private=opaque' } });
        h.page.goto = async (url) => { throw new Error(`Checkout page timed out while navigating to ${url}`); };
        let error;
        try { await openApiCheckout(h.page, { ...OPTIONS, verifyPage: true }); } catch (caught) { error = caught; }
        expect(error).toMatchObject({
            checkoutCreated: true, diagnostic: { phase: 'checkout-page', code: 'CHECKOUT_PAGE_FAILED' }
        });
        expect(JSON.stringify(error.diagnostic) + error.message).not.toMatch(/oaics_synthetic|private=opaque/);
        expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });
});

describe('actual Checkout service keeps structured safe errors', () => {
    it.each(['detail', 'error'])('preserves %s provider code, type, HTTP status and header IDs', async (key) => {
        const h = harness({ checkoutStatus: 400, checkoutBody: { [key]: {
            message: 'Our systems have detected unusual activity. Please try again later.', code: 'unusual_activity', type: 'risk_error'
        } }, headers: { 'X-Request-ID': 'synthetic-request-id', 'Retry-After': '60' } });
        let error;
        try { await openApiCheckout(h.page, OPTIONS); } catch (caught) { error = caught; }
        expect(error.message).toContain('API 创建 Checkout 失败: Our systems');
        expect(error.diagnostic).toMatchObject({ phase: 'checkout-create', httpStatus: 400,
            code: 'unusual_activity', type: 'risk_error', requestId: 'synthetic-request-id', retryAfter: '60' });
        expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });

    it.each([
        [429, { message: 'Slow down', code: 'rate_limit' }, 'rate_limit', 'Slow down'],
        [307, {}, 'HTTP_307', 'HTTP 307'],
        [200, {}, 'CHECKOUT_INVALID_RESPONSE', 'API 未返回 checkout_session_id 或 url'],
        [200, '<html>secret body not logged</html>', 'CHECKOUT_INVALID_RESPONSE', 'API 返回非 JSON 响应'],
        [503, '<html>secret body not logged</html>', 'HTTP_503', 'HTTP 503（API 返回非 JSON 响应）']
    ])('handles status %s without a second POST', async (status, body, code, message) => {
        const calls = [];
        const service = new ChatGPTService({ post: async (url, options) => {
            calls.push({ url, options }); return reply(status, body);
        } }, 'synthetic-test-token');
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        expect(result).toMatchObject({ checkoutUrl: null, error: message, diagnostic: { httpStatus: status, code } });
        expect(calls).toHaveLength(1);
        expect(calls[0].options).toMatchObject({ timeout: 30000, maxRetries: 0, maxRedirects: 0 });
        expect(JSON.stringify(result)).not.toContain('secret body');
    });

    it('redacts provider messages and ignores raw credential containers', async () => {
        const token = jwt();
        const service = new ChatGPTService({ post: async () => reply(400, { detail: {
            code: 'bad_request', message: `Failed token=${token}; proxy=http://user:privatepass@proxy.test:8080; card_number=4111111111111111`,
            session: { accessToken: 'never-log-this-session' }
        }, cookies: ['never-log-this-cookie'] }, { 'x-request-id': '17938085258340000001' }) }, token);
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        const output = JSON.stringify(result) + console.error.mock.calls.flat().join(' ');
        expect(output).not.toMatch(/synthetic-signature|privatepass|4111111111111111|never-log-this/);
        expect(result.diagnostic.requestId).toBe('17938085258340000001');
    });

    it('does not stringify unrecognized error objects', async () => {
        const service = new ChatGPTService({ post: async () => reply(400, { detail: {
            session_payload: 'unknown-secret', cookies: ['unknown-cookie']
        } }) }, 'synthetic-token');
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        expect(result.error).toBe('HTTP 400');
        expect(JSON.stringify(result)).not.toContain('unknown-secret');
    });

    it('redacts long echoed opaque tokens and encrypted session cookies before truncating', async () => {
        const token = `opaque_${'s'.repeat(1900)}`;
        const encrypted = 'eyJsynthetic..secret-iv.secret-ciphertext.secret-tag';
        const service = new ChatGPTService({ post: async () => reply(400, { detail: {
            message: `Echoed credentials ${token} and ${encrypted}`
        } }) }, token);
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        const output = JSON.stringify(result) + console.error.mock.calls.flat().join(' ');
        expect(output).not.toContain(token.slice(0, 80));
        expect(output).not.toContain('secret-ciphertext');
    });

    it('preserves status and request ID when the response body is unreadable', async () => {
        const response = reply(502, '', { 'x-request-id': 'unreadable-synthetic-id' });
        response.text = async () => { throw new Error('private body reader trace'); };
        const service = new ChatGPTService({ post: async () => response }, 'synthetic-token');
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        expect(result.diagnostic).toMatchObject({ httpStatus: 502, requestId: 'unreadable-synthetic-id',
            code: 'CHECKOUT_RESPONSE_UNREADABLE' });
        expect(JSON.stringify(result)).not.toContain('private body reader trace');
    });

    it('preserves a transport timeout as one safe failure', async () => {
        const token = jwt(); let calls = 0;
        const service = new ChatGPTService({ post: async () => {
            calls++; throw new Error(`Timeout 30000ms exceeded\nAuthorization: Bearer ${token}\nCookie: sid=unknown-cookie`);
        } }, token);
        const result = await service.createCheckoutSession('plus', 'PH', 'PHP');
        expect(result.diagnostic).toMatchObject({ code: 'CHECKOUT_TIMEOUT', type: 'network', httpStatus: null });
        expect(calls).toBe(1);
        expect(JSON.stringify(result)).not.toMatch(/unknown-cookie|synthetic-signature/);
    });

    it('only retains scalar allowlisted diagnostic fields', () => {
        const result = sanitizeCheckoutDiagnostic({ phase: 'checkout-create', httpStatus: 400,
            code: '17938085258340000001', message: 'Cookie: session=unknown-cookie',
            requestId: '17938085258340000002', token: 'never-log-token', arbitrary: { x: 1 }, latencyMs: -1 });
        expect(Object.keys(result)).toEqual(['phase', 'httpStatus', 'code', 'type', 'message', 'requestId', 'retryAfter', 'latencyMs']);
        expect(result.code).toBe('17938085258340000001');
        expect(result.requestId).toBe('17938085258340000002');
        expect(result.latencyMs).toBe(0);
        expect(JSON.stringify(result)).not.toMatch(/unknown-cookie|never-log-token/);
        expect(sanitizeCheckoutDiagnostic(null)).toBeNull();
        const hostileObject = { toString: 1, valueOf: 1 };
        expect(sanitizeCheckoutDiagnostic({ phase: hostileObject, httpStatus: hostileObject, latencyMs: hostileObject }))
            .toMatchObject({ phase: 'checkout-create', httpStatus: null, latencyMs: 0 });
    });
});

describe('real APIRequestContext bypasses the old browser Session mock', () => {
    it('reads true loopback session and posts its fresh token while page fetch still sees the mock', async () => {
        const fresh = jwt({ accountId: 'workspace_b' });
        let postCount = 0; let authorization = ''; let cookie = '';
        const server = http.createServer((request, response) => {
            response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'application/json');
            if (request.url === '/api/auth/session') {
                cookie = request.headers.cookie;
                response.end(JSON.stringify({ user: { id: 'user_same' }, accessToken: fresh }));
            } else if (request.url === '/backend-api/payments/checkout') {
                postCount++; authorization = request.headers.authorization;
                request.resume(); response.end(JSON.stringify({ checkout_session_id: 'oaics_synthetic' }));
            } else response.end('<html><body>Local audit</body></html>');
        });
        let browser;
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            browser = await chromium.launch({ headless: true });
            const context = await browser.newContext();
            await context.addCookies([{ name: 'synthetic_cookie', value: 'accepted', url: base }]);
            let routes = 0;
            await context.route('**/api/auth/session', async (route) => {
                routes++; await route.fulfill({ json: { accessToken: OLD_TOKEN, user: { id: 'user_same' } } });
            });
            const page = await context.newPage(); await page.goto(base);
            const mocked = await page.evaluate(() => fetch('/api/auth/session').then((response) => response.json()));
            expect(mocked.accessToken).toBe(OLD_TOKEN);
            const transport = {
                get: (url, options) => {
                    expect(url).toBe('https://chatgpt.com/api/auth/session');
                    return context.request.get(base + '/api/auth/session', options);
                },
                post: (url, options) => {
                    expect(url).toBe('https://chatgpt.com/backend-api/payments/checkout');
                    return context.request.post(base + '/backend-api/payments/checkout', options);
                }
            };
            const result = await openApiCheckout({ context: () => ({ request: transport }) }, OPTIONS);
            expect(result.diagnostic.httpStatus).toBe(200);
            expect(routes).toBe(1);
            expect(postCount).toBe(1);
            expect(authorization).toBe(`Bearer ${fresh}`);
            expect(cookie).toContain('synthetic_cookie=accepted');
            await context.close();
        } finally {
            if (browser) await browser.close();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
