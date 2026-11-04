'use strict';

const { requireReadablePlanType, getPlanLabel } = require('./plan-registry');
const ALL_PLANS = /^(See all plans|View all plans|Explore all plans|查看所有套餐|查看全部套餐|显示所有套餐|查看所有方案)$/i;

async function expandAllPlans(page) {
    for (const control of [page.getByRole('link', { name: ALL_PLANS }), page.getByRole('button', { name: ALL_PLANS }), page.getByText(ALL_PLANS)]) {
        const visible = control.filter({ visible: true });
        if (await visible.count() !== 1) continue;
        await visible.scrollIntoViewIfNeeded();
        await visible.click({ timeout: 10000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(700);
        console.log('✅ [步骤] 已展开全部套餐');
        return true;
    }
    return false;
}

async function findPricingUpgrade(page, planType) {
    const plan = requireReadablePlanType(planType);
    const target = plan === 'pro_5x' ? 'pro100' : plan === 'pro_20x' ? 'pro200' : plan;
    return page.evaluate((wanted) => {
        const visible = n => !!(n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none');
        const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
        const actions = [...document.querySelectorAll('button, a, [role="button"]')];
        const titlePattern = /^(?:ChatGPT\s+)?(Free|Go|Plus|Pro(?:\s*[-–]?\s*(?:100|200|500))?)(?:\s+(?:plan|套餐))?$/i;
        const family = value => /^pro/i.test(value) ? 'pro' : value.toLowerCase();
        const matches = [];
        for (let index = 0; index < actions.length; index++) {
            const button = actions[index];
            const buttonText = clean(button.innerText || button.getAttribute('aria-label'));
            if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
            if (!/^(?:[✦✨]\s*)?(?:Upgrade|Upgrade to (?:ChatGPT )?(?:Plus|Pro)(?:\s*(?:100|200|500))?|Get (?:ChatGPT )?(?:Plus|Pro)(?:\s*(?:100|200|500))?|Subscribe(?: to (?:ChatGPT )?(?:Plus|Pro)(?:\s*(?:100|200|500))?)?|Start now|Continue|升级(?:至\s*(?:Plus|Pro)(?:\s*(?:100|200|500))?)?|立即开始|立即订阅|订阅|继续)$/i.test(buttonText)) continue;
            let card = button.parentElement;
            for (let depth = 0; card && depth < 9; depth++, card = card.parentElement) {
                const text = clean(card.innerText);
                if (text.length > 6500) break;
                const titles = [...card.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],p,span,strong,div')]
                    .filter(n => visible(n) && n.children.length === 0)
                    .map(n => clean(n.innerText)).filter(t => titlePattern.test(t));
                const families = new Set(titles.map(t => family(t.match(titlePattern)[1])));
                if (!families.size) continue;
                if (families.size > 1) break;
                const requiredFamily = wanted === 'plus' ? 'plus' : 'pro';
                if (!families.has(requiredFamily)) break;
                const tiers = new Set(titles.map(t => t.match(/\bPro\s*[-–]?\s*(100|200|500)\b/i)?.[1]).filter(Boolean));
                // Only explicit USD plan prices can disambiguate a generic Pro card.
                const priceText = [...card.querySelectorAll('p,span,strong,div')]
                    .filter(n => visible(n) && clean(n.innerText).length < 70 && !n.querySelector('button,a'))
                    .map(n => clean(n.innerText));
                if (!tiers.size) {
                    for (const price of priceText) {
                        const usd = price.match(/^(?:US\$|USD\s*\$?|\$)\s*(100|200|500)(?:\.00)?(?:\s*(?:\/\s*(?:mo(?:nth)?|月)|USD|per month|a month))*$/i);
                        if (usd) tiers.add(usd[1]);
                    }
                }
                if (wanted === 'plus' || (tiers.size === 1 && tiers.has(wanted.slice(3)))) {
                    matches.push({ index, label: wanted, evidence: titles.join(' / ') });
                }
                break;
            }
        }
        return matches;
    }, target);
}

async function selectPricingUpgrade(page, planType) {
    const plan = requireReadablePlanType(planType);
    let matches = await findPricingUpgrade(page, plan);
    if (!matches.length && await expandAllPlans(page)) matches = await findPricingUpgrade(page, plan);
    if (matches.length !== 1) {
        const reason = matches.length ? '存在多个候选按钮，无法唯一确认' : '全部套餐页面未显示可确认的目标档位';
        throw new Error(`无法确认 ${getPlanLabel(plan)} 升级入口：${reason}；未点击其他套餐，请在账号升级页面核对实际套餐`);
    }
    const button = page.locator('button, a, [role="button"]').nth(matches[0].index);
    await button.scrollIntoViewIfNeeded();
    await button.click({ timeout: 10000 });
    console.log(`✅ [步骤] 已点击 ${getPlanLabel(plan)} 套餐卡片内的升级按钮`);
}

module.exports = { expandAllPlans, findPricingUpgrade, selectPricingUpgrade };
