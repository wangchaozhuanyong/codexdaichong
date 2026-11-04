'use strict';

const { CANONICAL_PLAN_TYPES, requireReadablePlanType, resolveCheckoutPlanName } = require('./plan-registry');

function normalizeLocalCheckoutConfig(input = {}) {
    const mode = String(input.mode || 'auto').trim().toLowerCase();
    if (!['auto', 'api', 'ui'].includes(mode)) throw new Error('本地开通方式必须是 auto / api / ui');
    const supplied = input.planNames || {};
    if (typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('本地套餐映射格式错误');
    for (const key of Object.keys(supplied)) {
        if (!CANONICAL_PLAN_TYPES.includes(key)) throw new Error(`不支持的本地套餐: ${key}`);
    }
    const planNames = Object.fromEntries(CANONICAL_PLAN_TYPES.map((type) => {
        const value = String(supplied[type] ?? (type === 'plus' ? 'chatgptplusplan' : '')).trim();
        if (value && !/^[a-z][a-z0-9_:-]{0,95}$/i.test(value)) throw new Error(`${type} 的套餐接口标识格式错误`);
        return [type, value];
    }));
    const configured = Object.values(planNames).filter(Boolean);
    if (new Set(configured).size !== configured.length) throw new Error('不同套餐不能使用相同的接口标识，请确认实际套餐');
    return { mode, planNames };
}

function buildLocalCheckoutEnv(input, planType, override = '') {
    const type = requireReadablePlanType(planType);
    const config = normalizeLocalCheckoutConfig(override ? {
        ...input, planNames: { ...input.planNames, [type]: override }
    } : input);
    let planName = config.planNames[type] || '';
    if (!CANONICAL_PLAN_TYPES.includes(type)) planName = resolveCheckoutPlanName(type);
    if (config.mode === 'api' && !planName) throw new Error(`${type} 的本地接口套餐标识未配置；请改用自动或网页模式`);
    return { CHECKOUT_MODE: config.mode, PLAN_NAME_OVERRIDE: planName };
}

module.exports = { normalizeLocalCheckoutConfig, buildLocalCheckoutEnv };
