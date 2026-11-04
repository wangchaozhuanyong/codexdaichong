'use strict';

const { normalizeLocalCheckoutConfig, buildLocalCheckoutEnv } = require('../local-checkout');

describe('persistent local checkout settings', () => {
    it('uses UI discovery for unconfigured Pro tiers without inventing an API code', () => {
        const config = normalizeLocalCheckoutConfig();
        expect(config.planNames.plus).toBe('chatgptplusplan');
        for (const tier of ['pro100', 'pro200', 'pro500']) {
            expect(buildLocalCheckoutEnv(config, tier)).toEqual({ CHECKOUT_MODE: 'auto', PLAN_NAME_OVERRIDE: '' });
        }
    });
    it('passes a confirmed tier-specific code to the ordinary and debug worker contract', () => {
        const config = { mode: 'api', planNames: { pro100: 'confirmed_pro100' } };
        expect(buildLocalCheckoutEnv(config, 'pro100')).toEqual({ CHECKOUT_MODE: 'api', PLAN_NAME_OVERRIDE: 'confirmed_pro100' });
        expect(() => buildLocalCheckoutEnv(config, 'pro200')).toThrow(/未配置/);
        expect(buildLocalCheckoutEnv(config, 'pro200', 'confirmed_pro200').PLAN_NAME_OVERRIDE).toBe('confirmed_pro200');
    });
    it('rejects a Plus fallback, duplicate tiers, unknown keys and malformed identifiers', () => {
        expect(() => normalizeLocalCheckoutConfig({ planNames: { pro100: 'chatgptplusplan' } })).toThrow(/相同/);
        expect(() => normalizeLocalCheckoutConfig({ planNames: { pro100: 'same', pro200: 'same' } })).toThrow(/相同/);
        expect(() => normalizeLocalCheckoutConfig({ planNames: { pro100: 'https://invalid.example' } })).toThrow(/格式/);
        expect(() => normalizeLocalCheckoutConfig({ planNames: { pro_5x: 'old' } })).toThrow(/不支持/);
        expect(() => normalizeLocalCheckoutConfig({ mode: 'pay' })).toThrow(/方式/);
        expect(() => buildLocalCheckoutEnv({}, 'mystery')).toThrow(/不受支持/);
    });
});
