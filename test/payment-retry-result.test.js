'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { redactSensitiveText } = require('../gpt-api-failure');

const source = fs.readFileSync(path.join(__dirname, '..', 'payment-retry.js'), 'utf8');
const unknownMessage = '支付结果检测失败：付款结果待核实，请勿重复充值';
const ambiguousError = 'The payment was not approved. card_declined token=synthetic-credential';

function createHarness(paymentResults, { billingError } = {}) {
    const calls = [];
    const records = [];
    const logs = [];
    let cardId = 0;
    const modules = {
        './mysql-store': {
            getPaymentRegion: async () => 'MY',
            getAppConfigValue: async () => null,
            reserveCard: async () => {
                cardId += 1;
                calls.push(`reserve:${cardId}`);
                return {
                    id: cardId,
                    card_number: `000000000000000${cardId}`,
                    card_expiry: '12/30',
                    card_cvc: '000'
                };
            },
            createBillingRecord: async (record) => {
                calls.push(`bill:${record.error_code || record.status}`);
                records.push(record);
                if (billingError) throw billingError;
            },
            markCardExhausted: async (id) => { calls.push(`exhaust:${id}`); },
            releaseCard: async (id) => { calls.push(`release:${id}`); },
            bindCardPaymentProfile: async (id) => { calls.push(`bind:${id}`); },
            recordCardUsage: async (id) => { calls.push(`use:${id}`); }
        },
        './stripe-payment': {
            completeStripeCardPayment: async (_page, _card, _address, { cardAttempt }) => {
                calls.push(`submit:${cardAttempt}`);
                const result = paymentResults[cardAttempt - 1];
                if (!result) throw new Error('Unexpected synthetic card attempt');
                return result;
            },
            readCheckoutDueAmount: async () => ({ amount: 20, currency: 'MYR' })
        },
        './tax-free-address': {
            pickBillingAddressForCheckout: async () => ({
                id: 42, line1: 'Fixture Street', city: 'Fixture City', state: 'OR'
            }),
            markAddressBound: async (id, card) => { calls.push(`bind-address:${id}:${card}`); }
        },
        './region-config': { getRegionConfig: () => ({ currency: 'MYR' }) },
        './plan-registry': { requireReadablePlanType: (plan) => plan },
        './gpt-api-failure': { redactSensitiveText }
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        require(name) {
            if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected require: ${name}`);
            return modules[name];
        },
        process: { env: { PAYMENT_MAX_CARD_ATTEMPTS: '2' } },
        console: {
            log(line) {
                logs.push(line);
                if (line === 'PAYMENT_RESULT_UNKNOWN') calls.push('report-unknown');
            }
        }
    }, { filename: 'payment-retry.js' });
    return {
        calls,
        records,
        logs,
        execute: () => module.exports.executePaymentWithRetry({}, { planType: 'plus' })
    };
}

describe('Stripe payment retry result evidence', () => {
    it.each([undefined, false, 'true'])('keeps existing manual handling without explicit decline (%s)', async (declined) => {
        const harness = createHarness([{ success: false, declined, error: ambiguousError }]);
        const result = await harness.execute();

        expect(harness.calls).toEqual(['reserve:1', 'submit:1', 'bill:form_validation_failed', 'release:1']);
        expect(result).toMatchObject({ success: false, manualIntervention: true });
        expect(result).not.toHaveProperty('cardsDeclined');
        expect(harness.records[0].error_message).not.toContain('synthetic-credential');
    });

    it.each([false, true])('stops on uncertainty even if decline is %s', async (declined) => {
        const harness = createHarness([{
            success: false,
            declined,
            canRetryCard: true,
            resultUnknown: true,
            error: ambiguousError,
            screenshot: 'debug_screenshots/payment_result_unknown.png'
        }]);
        const result = await harness.execute();

        expect(harness.calls).toEqual([
            'reserve:1', 'submit:1', 'report-unknown', 'bill:payment_result_unknown', 'release:1'
        ]);
        expect(harness.records[0]).toMatchObject({
            status: 'failed',
            error_code: 'payment_result_unknown',
            error_message: unknownMessage
        });
        expect(result).toMatchObject({
            success: false,
            manualIntervention: true,
            resultUnknown: true,
            error: unknownMessage,
            screenshots: ['debug_screenshots/payment_result_unknown.png']
        });
        expect(harness.logs).toContain('PAYMENT_RESULT_UNKNOWN');
        expect(harness.logs.join('\n')).not.toContain('synthetic-credential');
    });

    it('stores a bounded, redacted decline diagnostic before exhausting the card and retrying', async () => {
        const error = `token=synthetic-credential cvc=000 ${'长'.repeat(479)}${'💳'.repeat(100)}`;
        const harness = createHarness([
            { success: false, declined: true, canRetryCard: true, error },
            { success: true, dueAmount: 19, dueCurrency: 'MYR' }
        ]);
        const result = await harness.execute();

        expect(harness.calls).toEqual([
            'reserve:1', 'submit:1', 'bill:card_declined', 'exhaust:1',
            'reserve:2', 'submit:2', 'bind:2', 'bind-address:42:2', 'use:2', 'release:2', 'bill:success'
        ]);
        const diagnostic = harness.records[0].error_message;
        expect(diagnostic.length).toBeLessThanOrEqual(512);
        expect(diagnostic).toBe(diagnostic.toWellFormed());
        expect(diagnostic).toContain('token=[已隐藏]');
        expect(diagnostic).toContain('cvc=[已隐藏]');
        expect(diagnostic).not.toContain('synthetic-credential');
        expect(harness.records[1]).toMatchObject({ status: 'success', amount: 19, currency: 'MYR' });
        expect(result).toMatchObject({ success: true, cardLast4: '0002' });
    });

    it('stops on the second attempt when its result is unknown', async () => {
        const harness = createHarness([
            { success: false, declined: true, canRetryCard: true },
            { success: false, resultUnknown: true }
        ]);
        expect(await harness.execute()).toMatchObject({ success: false, resultUnknown: true });
        expect(harness.calls).toEqual([
            'reserve:1', 'submit:1', 'bill:card_declined', 'exhaust:1',
            'reserve:2', 'submit:2', 'report-unknown', 'bill:payment_result_unknown', 'release:2'
        ]);
    });

    it('honors the existing no-retry flag after an explicit decline', async () => {
        const harness = createHarness([{ success: false, declined: true, canRetryCard: false }]);
        const result = await harness.execute();

        expect(harness.calls).toEqual(['reserve:1', 'submit:1', 'bill:card_declined', 'exhaust:1']);
        expect(result).toMatchObject({ success: false, manualIntervention: true, cardsDeclined: 1 });
    });

    it('releases the card without exhausting it or trying another card if billing fails', async () => {
        const billingError = new Error('Synthetic database write failure');
        const harness = createHarness([{ success: false, declined: true, canRetryCard: true }], { billingError });

        await expect(harness.execute()).rejects.toBe(billingError);
        expect(harness.calls).toEqual(['reserve:1', 'submit:1', 'bill:card_declined', 'release:1']);
    });

    it('reports an unknown outcome even when its billing record cannot be saved', async () => {
        const billingError = new Error('Synthetic database write failure');
        const harness = createHarness([{ success: false, resultUnknown: true }], { billingError });

        await expect(harness.execute()).rejects.toBe(billingError);
        expect(harness.logs).toContain('PAYMENT_RESULT_UNKNOWN');
        expect(harness.calls).toEqual([
            'reserve:1', 'submit:1', 'report-unknown', 'bill:payment_result_unknown', 'release:1'
        ]);
    });
});
