'use strict';

const { chromium } = require('playwright');
const { clickPlanUpgrade, switchToPersonalPlans, verifyProPricingCheckout } = require('../pricing-checkout');

let browser;
let context;
let page;
let requests;

beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
    context = await browser.newContext();
    requests = [];
    await context.route('**/*', async (route) => {
        requests.push(route.request().url());
        await route.abort();
    });
    page = await context.newPage();
});

afterEach(async () => {
    await context.close();
    expect(requests).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
});

function card(title, id, button) {
    return `<section><div><h2>${title}</h2></div><p>Plan details</p>
        <button id="${id}" onclick="document.body.dataset.clicked=this.id">${button}</button></section>`;
}

async function showPricing(cards, extra = '') {
    await page.setContent(`<main>
        <button id="unrelated" onclick="document.body.dataset.clicked=this.id">Start now</button>
        <div role="dialog" aria-label="Upgrade your plan">
            <button role="tab" aria-selected="true"
                onclick="document.body.dataset.tabClicked='yes'">Personal</button>
            <button role="tab" aria-selected="false">Business</button>
            <div>${cards}</div>
        </div>${extra}</main>`);
}

describe('pricing page Plus button compatibility', () => {
    it('clicks Start now only inside the Plus card, with other Start now buttons present', async () => {
        await showPricing(card('Free', 'free', 'Start now')
            + card('Plus', 'plus', 'Start now')
            + card('Pro', 'pro', 'Start now'));

        await clickPlanUpgrade(page, 'plus');

        expect(await page.locator('body').getAttribute('data-clicked')).toBe('plus');
    });

    it('recognizes the new Personal view without repeatedly clicking the Personal tab', async () => {
        await showPricing(card('Plus', 'plus', 'Start now'));
        await page.getByRole('tab', { name: 'Personal' }).evaluate((node) => node.removeAttribute('aria-selected'));

        await switchToPersonalPlans(page);

        expect(await page.locator('body').getAttribute('data-tab-clicked')).toBeNull();
        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });

    it.each(['Get Plus', 'Upgrade to Plus', 'Subscribe to Plus'])(
        'preserves the existing %s button path', async (label) => {
            await showPricing(card('ChatGPT Plus', 'plus', label));

            await clickPlanUpgrade(page, 'plus');

            expect(await page.locator('body').getAttribute('data-clicked')).toBe('plus');
        }
    );

    it('does not take a Start now button from another plan when Plus has no action', async () => {
        await showPricing('<section><h2>Plus</h2><p>Unavailable</p></section>'
            + card('Pro', 'pro', 'Start now'));

        await expect(clickPlanUpgrade(page, 'plus')).rejects.toThrow(/未找到 plus 套餐的升级按钮/);

        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });

    it('does not select a disabled Plus Start now button or another plan instead', async () => {
        await showPricing('<section><h2>Plus</h2><button disabled>Start now</button></section>'
            + card('Free', 'free', 'Start now'));

        await expect(clickPlanUpgrade(page, 'plus')).rejects.toThrow(/未找到 plus 套餐的升级按钮/);

        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });

    it('preserves the historical Pro action when a Plus Start now button is also visible', async () => {
        await showPricing(card('Plus', 'plus', 'Start now')
            + card('ChatGPT Pro', 'pro', 'Upgrade to Pro'));

        await clickPlanUpgrade(page, 'pro_20x');

        expect(await page.locator('body').getAttribute('data-clicked')).toBe('pro');
    });

    it('ignores a hidden Plus heading and finds the visible card', async () => {
        await showPricing('<section hidden><h2>Plus</h2><button>Start now</button></section>'
            + card('ChatGPT Plus', 'plus', 'Start now'));

        await clickPlanUpgrade(page, 'plus');

        expect(await page.locator('body').getAttribute('data-clicked')).toBe('plus');
    });

    it('rejects an ambiguous Plus card with two Start now buttons', async () => {
        await showPricing('<section><h2>Plus</h2><button>Start now</button>'
            + '<button>Start now</button></section>');

        await expect(clickPlanUpgrade(page, 'plus')).rejects.toThrow(/未找到 plus 套餐的升级按钮/);

        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });
});

const TIER_PRICE = { 100: '420', 200: '999.90', 500: '2,100' };

async function showProTiers({ tiers = ['100', '200', '500'], startsExpanded = false } = {}) {
    await page.setContent(`<main>
        <button onclick="document.body.dataset.clicked='wrong-expander'">查看所有套餐</button>
        <div role="dialog" aria-label="升级套餐">
            <div role="radiogroup" aria-label="套餐类型">
                <button role="radio" aria-checked="false" onclick="this.setAttribute('aria-checked','true');
                    document.getElementById('business').setAttribute('aria-checked','false');
                    document.getElementById('personal-plans').hidden=false;">个人</button>
                <button id="business" role="radio" aria-checked="true">Business</button>
            </div>
            <div id="personal-plans" hidden>
                ${card('Plus', 'plus', '立即体验')}
                <button onclick="document.getElementById('pro').hidden=false; this.hidden=true;">查看所有套餐</button>
                <section id="pro" ${startsExpanded ? '' : 'hidden'}>
                    <header><h2>Pro</h2><div role="radiogroup" aria-label="Pro 用量">
                        ${tiers.map((tier) => `<button role="radio" aria-checked="${tier === '100'}"
                            onclick="for(const r of this.parentElement.children) r.setAttribute('aria-checked', String(r===this));
                                document.getElementById('pro-price').innerText='RM ${TIER_PRICE[tier]}'">${tier}</button>`).join('')}
                    </div></header>
                    <button id="pro-action" onclick="document.body.dataset.clicked=this.id;
                        document.body.dataset.tier=document.querySelector('#pro [aria-checked=true]').innerText">立即体验</button>
                    <div class="pricing-column-price-block"><span class="sr-only" id="pro-price">RM 420</span>
                        <span aria-hidden="true">RM 420 0 1 2 3 4 5 6 7 8 9</span><span>/ 月</span></div>
                </section>
            </div>
        </div>
    </main>`);
}

describe('canonical Pro pricing tiers', () => {
    it.each([['100', 42000], ['200', 99990], ['500', 210000]])(
        'switches to Personal, expands the plan list, and opens only the selected Pro %s', async (tier, amount) => {
            await showProTiers();

            await expect(clickPlanUpgrade(page, `pro${tier}`, { currency: 'MYR' })).resolves.toEqual({ tier, currency: 'MYR', amount });
            expect(await page.locator('body').getAttribute('data-tier')).toBe(tier);
            expect(await page.locator('body').getAttribute('data-clicked')).toBe('pro-action');
        });

    it('stops when a requested tier is missing even if another plan has an upgrade button', async () => {
        await showProTiers({ tiers: ['100', '200'], startsExpanded: true });
        await page.locator('main').evaluate((main) => {
            const other = document.createElement('button');
            other.textContent = 'Upgrade to Pro';
            other.onclick = () => { document.body.dataset.clicked = 'wrong-pro'; };
            main.prepend(other);
        });

        await expect(clickPlanUpgrade(page, 'pro500', { currency: 'MYR' })).rejects.toThrow(/Pro 500 档位/);
        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });

    it('stops before checkout when the price is in another currency', async () => {
        await showProTiers();

        await expect(clickPlanUpgrade(page, 'pro100', { currency: 'PHP' })).rejects.toThrow(/PHP 月费/);
        expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    });
});

describe('Pro Checkout verification', () => {
    async function showProCheckout({ selected = '100', currency = 'MYR', due = '420.00', duplicate = false } = {}) {
        const url = 'https://chatgpt.com/checkout/openai_llc/test';
        await page.route(url, (route) => route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<main><h1>配置你的套餐</h1><h3>Pro 订阅套餐</h3><div role="radiogroup">
                ${['100', '200', '500'].map((tier) => `<button role="radio" aria-checked="${tier === selected}">
                    <span>${currency} ${duplicate && tier === '200' ? '420' : TIER_PRICE[tier]}</span>
                    <span>${tier === '100' ? '标准' : '更高使用额度'}</span></button>`).join('')}
                </div><h2>ChatGPT Pro</h2><div><span>今日应付金额</span><span>${currency} ${due}</span></div></main>`
        }));
        await page.goto(url);
    }

    const pro100 = { tier: '100', currency: 'MYR', amount: 42000 };

    it('accepts the matching selected checkout option and total', async () => {
        await showProCheckout();
        await expect(verifyProPricingCheckout(page, pro100)).resolves.toBeUndefined();
    });

    it.each([
        ['different selected option', { selected: '200' }],
        ['different total', { due: '999.90' }],
        ['different currency', { currency: 'USD' }],
        ['ambiguous amount across options', { duplicate: true }]
    ])('rejects %s before payment', async (_, options) => {
        await showProCheckout(options);
        await expect(verifyProPricingCheckout(page, pro100)).rejects.toThrow(/已停止开通/);
    });
});
