'use strict';

const { chromium } = require('playwright');
const { clickPlanUpgrade, switchToPersonalPlans } = require('../pricing-checkout');

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

    it('preserves Pro selection when a Plus Start now button is also visible', async () => {
        await showPricing(card('Plus', 'plus', 'Start now')
            + card('ChatGPT Pro', 'pro', 'Upgrade to Pro'));

        await clickPlanUpgrade(page, 'pro200');

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
