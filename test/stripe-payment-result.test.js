import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../stripe-payment.js', import.meta.url), 'utf8');
const resultPhase = source.slice(
    source.indexOf('const PAYMENT_RESULT_TIMEOUT_MS'),
    source.indexOf('// ==================== Internal Helpers')
);

function loadResultPhase(overrides = {}) {
    const context = vm.createContext({
        process: { env: {
            CAPTCHA_OVERLAY_WAIT_MS: '80',
            POST_SUBMIT_POLL_MS: '10',
            PAYMENT_RESULT_TIMEOUT_MS: '200'
        } },
        console: { log: vi.fn() },
        clickCheckoutSubmitButton: vi.fn(async () => true),
        hasAnyCheckoutCaptchaSignal: vi.fn(async () => false),
        isHumanVerificationVisible: vi.fn(async () => false),
        saveDebugScreenshot: vi.fn(async (_page, prefix) => prefix),
        ...overrides
    });
    vm.runInContext(resultPhase, context);
    return context;
}

describe('visible checkout payment result', () => {
    let browser;
    let page;
    let checkout;
    let externalRequests;

    beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
    afterAll(async () => { await browser?.close(); });

    beforeEach(async () => {
        page = await browser.newPage();
        externalRequests = [];
        await page.route('**/*', (route) => {
            if (route.request().url() === 'https://checkout.test/pay') {
                return route.fulfill({ body: '<main>Checkout</main>', contentType: 'text/html' });
            }
            externalRequests.push(route.request().url());
            return route.abort();
        });
        await page.goto('https://checkout.test/pay');
        checkout = new Proxy(page, {
            get(target, property) {
                if (property === 'waitForTimeout') {
                    return (ms) => target.waitForTimeout(Math.min(ms, 10));
                }
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    });

    afterEach(async () => {
        await page?.close();
        expect(externalRequests).toEqual([]);
    });

    it('ignores the 108286-character script match from the old refusal detector', async () => {
        const falseMatch = 'incorrect' + 'x'.repeat(108274) + 'cvc';
        await page.setContent(`<main>Processing</main><script type="application/json">"${falseMatch}"</script>`);
        expect((await page.textContent('body')).match(/incorrect.*cvc/i)?.[0]).toHaveLength(108286);
        const phase = loadResultPhase();
        const result = await phase.finalizeCheckoutPayment(checkout, 'Test');
        expect(phase.clickCheckoutSubmitButton).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            success: false, resultUnknown: true, declined: false, canRetryCard: false,
            screenshot: 'payment_result_timeout'
        });
        expect(result.error).not.toContain('checkout.test');
    });

    it('ignores hidden refusals and confirmation text, and never joins separate lines', async () => {
        await page.setContent(`
            <p hidden>Your card was declined.</p>
            <p style="visibility: hidden">Your card has been declined.</p>
            <section style="opacity: 0"><p>Insufficient funds.</p></section>
            <p hidden>Thank you for subscribing!</p>
            <div>Incorrect<br>CVC</div>
            <p>If your card was declined, contact your bank.</p>
            <p>Payment details are being checked.</p>
            <p>未确认支付成功</p>
            <p>Your card was declined. ${"x".repeat(241)}</p>
        `);
        const phase = loadResultPhase();
        expect(await phase.finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, resultUnknown: true, canRetryCard: false,
            screenshot: 'payment_result_timeout'
        });
    });

    it('ignores screen-reader-only, clipped, and off-page text', async () => {
        await page.setContent(`
            <p style="position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden">Your card was declined.</p>
            <div style="height:0;overflow:hidden"><p>Incorrect CVC.</p></div>
            <p style="clip-path:inset(50%)">Insufficient funds.</p>
            <p style="position:absolute;left:-9999px">Your card has been declined.</p>
        `);
        expect(await loadResultPhase().finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, resultUnknown: true, canRetryCard: false,
            screenshot: 'payment_result_timeout'
        });
    });

    it('recognizes a visible refusal elsewhere on the scrollable checkout page', async () => {
        await page.setContent('<p role="alert">Your card was declined.</p><div style="height:2000px"></div>');
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        expect(await loadResultPhase().finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, declined: true, canRetryCard: true, screenshot: 'payment_declined'
        });
    });

    it.each([
        '<p role="alert">Your card was declined. Try a different card.</p>',
        '<p>Your card’s <strong>security code</strong> is incorrect.</p>',
        '<p>银行卡被拒绝。</p>'
    ])('retains the fast path for an explicit visible refusal (%s)', async (html) => {
        await page.setContent(html);
        const phase = loadResultPhase();
        expect(await phase.finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, declined: true, canRetryCard: true, screenshot: 'payment_declined'
        });
        expect(phase.clickCheckoutSubmitButton).toHaveBeenCalledTimes(1);
        expect(phase.hasAnyCheckoutCaptchaSignal).not.toHaveBeenCalled();
    });

    it('recognizes the same explicit refusal during final polling', async () => {
        await page.setContent('<p role="alert">Insufficient funds.</p>');
        expect(await loadResultPhase().waitForPaymentResult(checkout, 'Test')).toMatchObject({
            success: false, declined: true, canRetryCard: true, screenshot: 'payment_declined'
        });
    });

    it('treats a visible generic failure as unknown', async () => {
        await page.setContent('<p role="alert">Payment could not be processed. Try a different card.</p>');
        expect(await loadResultPhase().finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, resultUnknown: true, declined: false, canRetryCard: false,
            screenshot: 'payment_result_unknown'
        });
    });

    it('retains visible confirmation and the existing success redirect', async () => {
        await page.setContent('<main>Thank you for subscribing!</main>');
        expect(await loadResultPhase().waitForPaymentResult(checkout, 'Test')).toMatchObject({
            success: true, holderName: 'Test'
        });

        await page.setContent('<main>Processing</main>');
        await page.evaluate(() => history.replaceState({}, '', '?redirect_status=succeeded'));
        expect(await loadResultPhase().finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: true, holderName: 'Test'
        });
    });

    it('preserves the post-submit verification branch', async () => {
        const clearHumanVerification = vi.fn(async () => ({ cleared: false }));
        const phase = loadResultPhase({
            hasAnyCheckoutCaptchaSignal: vi.fn(async () => true),
            clearHumanVerification,
            buildCaptchaRequiredError: () => 'synthetic verification required'
        });
        expect(await phase.finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, captchaRequired: true, error: 'synthetic verification required'
        });
        expect(clearHumanVerification).toHaveBeenCalledWith(checkout, expect.objectContaining({ phase: 'post_submit' }));
        expect(phase.clickCheckoutSubmitButton).toHaveBeenCalledTimes(1);
    });

    it('keeps a browser error after submission in the unknown state', async () => {
        const phase = loadResultPhase({
            hasAnyCheckoutCaptchaSignal: vi.fn(async () => { throw new Error('browser disconnected'); })
        });
        expect(await phase.finalizeCheckoutPayment(checkout, 'Test')).toMatchObject({
            success: false, resultUnknown: true, canRetryCard: false,
            screenshot: 'payment_result_unknown'
        });
    });
});
