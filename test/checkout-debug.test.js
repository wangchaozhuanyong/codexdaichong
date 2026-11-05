'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const vm = require('vm');
const { chromium } = require('playwright');
const { verifyCheckoutDebugPage } = require('../chatgpt');
const { openPricingCheckout } = require('../pricing-checkout');
const { sanitizeCheckoutDiagnostic } = require('../checkout-api-diagnostic');

const PAYMENT_URL = 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic';
const PAYMENT_HTML = '<h1>Configure your plan</h1><form onsubmit="document.body.dataset.submitted=1;return false">'
    + '<input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc">'
    + '<button type="submit">Subscribe</button></form>';

function extract(source, startMarker, endMarker) {
    source = source.replace(/\r\n/g, '\n');
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error(`Missing source boundary: ${startMarker}`);
    return source.slice(start, end);
}

function createWorkerPhase({ apiError, uiError, verifyError, screenshot = 'debug_screenshots/checkout_debug/ready.png',
    debugOnly = true, mode = 'api', apiOnly = false } = {}) {
    const messages = [];
    const calls = [];
    let currentUrl = 'https://chatgpt.com/';
    const context = {
        console: { log: (...args) => messages.push(args.join(' ')), warn: (...args) => messages.push(args.join(' ')) },
        process: { env: { CHECKOUT_MODE: mode, CHECKOUT_API_ONLY: apiOnly ? '1' : '0' } },
        sanitizeCheckoutDiagnostic,
        debugOnly,
        CONFIG: { planNameOverride: 'synthetic_plan', chatgptToken: 'synthetic-token' },
        loginInfo: { session: { accessToken: 'synthetic-token' } },
        planType: 'plus', billingCountry: 'MY', billingCurrency: 'MYR',
        cdkCode: '', email: '', context: {}, paymentSucceeded: false,
        page: { url: () => currentUrl },
        openApiCheckout: async (_page, options) => {
            calls.push(['api', options]);
            if (apiError) throw apiError instanceof Error ? apiError : new Error(apiError);
            return { checkoutUrl: PAYMENT_URL };
        },
        openPricingCheckout: async (_page, options) => {
            calls.push(['ui', options]);
            if (uiError) throw new Error(uiError);
            currentUrl = PAYMENT_URL;
        },
        verifyCheckoutDebugPage: async (_page, options) => {
            calls.push(['verify', options]);
            if (verifyError) throw new Error(verifyError);
            currentUrl = PAYMENT_URL;
            return { checkoutUrl: PAYMENT_URL };
        },
        captureDebugScreenshot: async () => { calls.push(['screenshot']); return screenshot; },
        executePaymentWithRetry: async () => {
            calls.push(['payment']);
            if (debugOnly) throw new Error('DEBUG MUST NEVER CALL PAYMENT');
            return { success: true, screenshots: [] };
        }
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const phase = extract(source, '        // --- Phase 2: API 创建 Checkout',
        '    } catch (e) {\n        console.error("❌ [运行时错误]');
    const sandbox = vm.createContext(context);
    vm.runInContext(`this.runPhase = async function () { ${phase}\n };`, sandbox);
    return { run: sandbox.runPhase, calls, messages, configure: (dependencies) => Object.assign(sandbox, dependencies) };
}

describe('actual checkout worker phase: debug stops before payment', () => {
    it('opens and verifies the API result before saving a screenshot and success markers', async () => {
        const h = createWorkerPhase();
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'verify', 'screenshot']);
        expect(h.calls[0][1].verifyPage).toBe(false);
        expect(h.messages.join('\n')).toContain('CHECKOUT_PAGE_READY');
        expect(h.messages.join('\n')).toContain('CHECKOUT_DEBUG_SUCCESS');
        expect(h.messages.join('\n')).toContain('SUCCESS_SCREENSHOT:');
    });

    it('falls back after API unusual activity, then verifies and stops without any payment call', async () => {
        const h = createWorkerPhase({ apiError: 'Our systems have detected unusual activity.' });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'verify', 'screenshot']);
        expect(h.calls[1][1]).toEqual({ region: 'MY', planType: 'plus' });
        expect(h.messages.join('\n')).toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('preserves the real UI failure and never announces success', async () => {
        const h = createWorkerPhase({ apiError: 'API 400', uiError: '未找到 plus 套餐的升级按钮' });
        await expect(h.run()).rejects.toThrow(/未找到 plus/);
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui']);
        expect(h.messages.join('\n')).not.toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('fails if a generated link does not load a form', async () => {
        const h = createWorkerPhase({ verifyError: 'Checkout 支付表单未能加载' });
        await expect(h.run()).rejects.toThrow(/支付表单未能加载/);
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'verify']);
        expect(h.messages.join('\n')).not.toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('requires a saved screenshot before reporting completion', async () => {
        const h = createWorkerPhase({ screenshot: null });
        await expect(h.run()).rejects.toThrow(/截图未能保存/);
        expect(h.messages.join('\n')).not.toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('supports explicit UI debugging while skipping API creation', async () => {
        const h = createWorkerPhase({ mode: 'ui' });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['ui', 'verify', 'screenshot']);
    });

    it('preserves formal API activation, including its existing payment call', async () => {
        const h = createWorkerPhase({ debugOnly: false });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'payment']);
        expect(h.calls[0][1].verifyPage).toBe(true);
    });

    it('preserves formal pricing fallback after an API failure', async () => {
        const h = createWorkerPhase({ debugOnly: false, apiError: 'API 400' });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'payment']);
    });
    it.each([
        'HTTP 400 unusual_activity',
        'HTTP 429 rate limit',
        'API session expired',
        'API session user mismatch',
        'Timeout 30000ms exceeded',
        'Malformed checkout response',
        'Checkout page verification failed'
    ])('keeps the formal pricing fallback and payment after %s', async (reason) => {
        const h = createWorkerPhase({ debugOnly: false, apiError: reason });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'payment']);
        expect(h.calls.filter(([kind]) => kind === 'ui')).toHaveLength(1);
        expect(h.messages.join('\n')).toContain('正在回退到 UI 定价页流程');
        expect(h.messages.join('\n')).toContain('CHECKOUT_SOURCE: ui');
        expect(h.messages.join('\n')).toContain('"outcome":"failed"');
    });

    it('passes the expected session identity to the API branch', async () => {
        const h = createWorkerPhase();
        await h.run();
        expect(h.calls[0][1].sessionData).toEqual({ accessToken: 'synthetic-token' });
        expect(h.messages.join('\n')).toContain('CHECKOUT_SOURCE: api');
    });

    it('stops API-only debugging after rejection without touching UI or payment', async () => {
        const h = createWorkerPhase({ apiOnly: true, apiError: 'HTTP 400 unusual_activity' });
        await expect(h.run()).rejects.toThrow(/unusual_activity/);
        expect(h.calls.map(([kind]) => kind)).toEqual(['api']);
        expect(h.messages.join('\n')).not.toContain('CHECKOUT_SOURCE:');
        expect(h.messages.join('\n')).not.toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('ignores the API-only diagnostic flag for formal recharge', async () => {
        const h = createWorkerPhase({ debugOnly: false, apiOnly: true, apiError: 'HTTP 400' });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'payment']);
    });

    it('does not send a second API request after a successful API-only debug run', async () => {
        const h = createWorkerPhase({ apiOnly: true });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'verify', 'screenshot']);
        expect(h.messages.join('\n')).toContain('CHECKOUT_DEBUG_SUCCESS');
    });

    it('keeps API creation success distinct from a later page failure and UI recovery', async () => {
        const error = new Error('Checkout page verification failed');
        error.checkoutCreated = true;
        error.diagnostic = { phase: 'checkout-page', httpStatus: 200, message: error.message };
        const h = createWorkerPhase({ debugOnly: false, apiError: error });
        await h.run();
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'payment']);
        const marker = h.messages.find((line) => line.startsWith('CHECKOUT_API_RESULT:'));
        expect(JSON.parse(marker.slice('CHECKOUT_API_RESULT:'.length)).outcome).toBe('success');
        expect(h.messages.join('\n')).toContain('CHECKOUT_SOURCE: ui');
    });

    it('redacts credentials from diagnostic markers and warnings', async () => {
        const error = new Error('Authorization: Bearer synthetic-secret');
        error.diagnostic = { phase: 'checkout-create', message: error.message,
            code: 'unusual_activity', httpStatus: 400, requestId: 'request-synthetic',
            accessToken: 'synthetic-secret', cookies: [{ value: 'cookie-secret' }] };
        const h = createWorkerPhase({ apiError: error });
        await h.run();
        const output = h.messages.join('\n');
        expect(output).not.toContain('synthetic-secret');
        expect(output).not.toContain('cookie-secret');
        expect(output).toContain('unusual_activity');
        expect(output).toContain('request-synthetic');
        expect(h.calls.map(([kind]) => kind)).toEqual(['api', 'ui', 'verify', 'screenshot']);
    });

});

describe('passive checkout debug browser verification', () => {
    let browser;
    let context;
    let page;

    beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
    beforeEach(async () => {
        context = await browser.newContext();
        page = await context.newPage();
    });
    afterEach(async () => { await context.close(); });
    afterAll(async () => { await browser?.close(); });

    async function fixture(html) {
        // Every browser request is fulfilled locally; no real account or network is used.
        await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    }

    async function assertUntouched() {
        expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
        for (const frame of page.frames()) {
            for (const input of await frame.locator('input').all()) {
                expect(await input.inputValue()).toBe('');
            }
        }
    }

    it('opens a returned API URL and observes the form without entering or submitting anything', async () => {
        await fixture(PAYMENT_HTML);
        const result = await verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL });
        expect(result.checkoutUrl).toBe(PAYMENT_URL);
        await assertUntouched();
    });

    it('runs the real pricing fallback, clicks Plus Start now, opens the form and saves a screenshot', async () => {
        const requested = [];
        const pricingHtml = '<h1>OFFLINE TEST - synthetic pricing page</h1>'
            + '<main><div role="dialog"><button role="tab" aria-selected="true">Personal</button>'
            + '<section><h2>Free</h2><button>Your current plan</button></section>'
            + '<section><h2>Plus</h2><p>RM 99 / month</p>'
            + '<button onclick="location.href=\'' + PAYMENT_URL + '\'">Start now</button></section></div></main>';
        await context.route('**/*', async (route) => {
            const url = route.request().url();
            requested.push(url);
            if (url === PAYMENT_URL) {
                await route.fulfill({ contentType: 'text/html',
                    body: '<h1>OFFLINE TEST - synthetic checkout, no payment</h1>' + PAYMENT_HTML });
            } else if (url.startsWith('https://chatgpt.com/')) {
                await route.fulfill({ contentType: 'text/html', body: pricingHtml });
            } else {
                await route.abort();
                throw new Error('Unexpected fixture request: ' + url);
            }
        });
        const h = createWorkerPhase({ apiError: 'API 创建 Checkout 失败: unusual activity' });
        const screenshotPath = path.join(os.tmpdir(), `kc-checkout-debug-${randomUUID()}.png`);
        h.configure({ page, context, openPricingCheckout, verifyCheckoutDebugPage,
            captureDebugScreenshot: async () => {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                return screenshotPath;
            } });

        try {
            await h.run();

            expect(page.url()).toBe(PAYMENT_URL);
            expect(requested).toContain(PAYMENT_URL);
            expect(h.calls.map(([kind]) => kind)).toEqual(['api']);
            expect(h.messages.join('\n')).toContain('CHECKOUT_PAGE_READY');
            expect(h.messages.join('\n')).toContain('CHECKOUT_DEBUG_SUCCESS');
            expect(fs.readFileSync(screenshotPath).subarray(1, 4).toString()).toBe('PNG');
            await assertUntouched();
        } finally {
            if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
        }
    });

    it('waits for delayed card fields instead of succeeding on a heading and Subscribe button', async () => {
        await fixture('<h1>Configure your plan</h1><button>Subscribe</button>'
            + '<script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",'
            + '\'<input autocomplete="cc-number">\'),100)</script>');
        await verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL, timeoutMs: 2000 });
        await assertUntouched();
    });

    it('observes card fields inside an iframe without filling them', async () => {
        await fixture('<iframe srcdoc=\'<input autocomplete="cc-number"><input autocomplete="cc-csc">\'></iframe>');
        await verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL, timeoutMs: 2000 });
        await assertUntouched();
    });

    it('does not succeed on a checkout URL with only pricing text and a Subscribe button', async () => {
        await fixture('<h1>Configure your plan</h1><p>Due today</p><button>Subscribe</button>');
        await expect(verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL, timeoutMs: 1000 }))
            .rejects.toThrow(/支付表单未能加载/);
        await assertUntouched();
    });

    it('does not treat a hidden card field as a loaded form', async () => {
        await fixture('<input autocomplete="cc-number" hidden>');
        await expect(verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL, timeoutMs: 1000 }))
            .rejects.toThrow(/支付表单未能加载/);
    });

    it('rejects a login redirect instead of reporting checkout success', async () => {
        await fixture('<h1>Sign in to continue</h1>');
        const navigate = page.goto.bind(page);
        page.goto = () => navigate('https://chatgpt.com/auth/login');
        await expect(verifyCheckoutDebugPage(page, { checkoutUrl: PAYMENT_URL }))
            .rejects.toThrow(/登录/);
    });

    it('rejects an unrelated URL before navigating', async () => {
        await expect(verifyCheckoutDebugPage(page, { checkoutUrl: 'https://example.com/checkout/' }))
            .rejects.toThrow(/有效的 Checkout/);
        expect(page.url()).toBe('about:blank');
    });
});

describe('checkout debug result presentation', () => {
    it('finishes manual-review outcomes as failed debug tasks without retries or card/phone deletion', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const sandbox = vm.createContext({
            extractRuntimeErrorMessage: () => 'Synthetic blocked form',
            analyzeProcessOutput: () => ({ status: 'manual', shouldRetry: true, deleteCard: true, deletePhone: true })
        });
        vm.runInContext(extract(source, 'function extractCheckoutUrlFromOutput(', 'function extractCardLast4FromOutput(')
            + '\nthis.analyze = analyzeCheckoutDebugOutput;', sandbox);
        const result = sandbox.analyze('Synthetic blocked form', false);
        expect(result.status).toBe('failed');
        expect(result.message).toBe('Synthetic blocked form');
        expect(result.shouldRetry).toBe(false);
        expect(result.deleteCard).toBe(false);
        expect(result.deletePhone).toBe(false);
    });

    it('keeps an API warning while reporting the later verified UI result as successful', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const sandbox = vm.createContext({
            extractRuntimeErrorMessage: () => '',
            analyzeProcessOutput: () => ({ status: 'failed', message: 'synthetic failure' })
        });
        vm.runInContext(extract(source, 'function extractCheckoutUrlFromOutput(', 'function extractCardLast4FromOutput(')
            + '\nthis.analyze = analyzeCheckoutDebugOutput;', sandbox);
        const result = sandbox.analyze('API Checkout 失败: unusual activity\nCHECKOUT_URL: ' + PAYMENT_URL
            + '\nCHECKOUT_PAGE_READY\nCHECKOUT_DEBUG_SUCCESS', false);
        expect(result.status).toBe('success');
        expect(result.checkoutPageReady).toBe(true);
        expect(result.message).toContain('未填卡、未付款');
        const legacy = sandbox.analyze('CHECKOUT_URL: ' + PAYMENT_URL + '\nCHECKOUT_DEBUG_SUCCESS', false);
        expect(legacy.checkoutPageReady).toBe(false);
        expect(legacy.reachedPayment).toBe(false);
    });

    it('never treats text inside a diagnostic as a page-ready or payment marker', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        const sandbox = vm.createContext({
            extractRuntimeErrorMessage: () => 'Checkout API rejected',
            analyzeProcessOutput: (output) => ({ status: output.includes('PAYMENT_SUCCESS') ? 'success' : 'failed' })
        });
        vm.runInContext(extract(source, 'function extractCheckoutUrlFromOutput(', 'function extractCardLast4FromOutput(')
            + '\nthis.analyze = analyzeCheckoutDebugOutput; this.extractUrl = extractCheckoutUrlFromOutput;', sandbox);
        const output = 'CHECKOUT_API_RESULT: ' + JSON.stringify({ outcome: 'failed', diagnostic: {
            message: 'CHECKOUT_DEBUG_SUCCESS CHECKOUT_PAGE_READY PAYMENT_SUCCESS CHECKOUT_URL: https://invalid.test/'
        } });
        expect(sandbox.analyze(output, false).status).toBe('failed');
        expect(sandbox.extractUrl(output)).toBe('');
    });

    it('renders the verified page and success screenshot without labelling it as failure', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
        const elements = new Map();
        const sandbox = vm.createContext({
            document: { getElementById: (id) => {
                if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '' });
                return elements.get(id);
            } },
            checkoutDebugJobKey: 'synthetic-job', escapeHtml: String,
            buildScreenshotUrl: (value) => '/synthetic/' + value
        });
        vm.runInContext(extract(source, '        function renderCheckoutDebugStatus(data)',
            '        async function pollCheckoutDebugStatus(') + '\nthis.render = renderCheckoutDebugStatus;', sandbox);
        sandbox.render({ status: 'success', checkout_page_ready: true, checkout_url: PAYMENT_URL,
            screenshots: ['checkout_debug/ready.png'] });
        expect(elements.get('checkout_result_status').textContent).toContain('未填卡、未付款');
        expect(elements.get('checkout_screenshot_wrap').innerHTML).toContain('调试截图');
        expect(elements.get('checkout_screenshot_wrap').innerHTML).not.toContain('失败截图');
    });
});
