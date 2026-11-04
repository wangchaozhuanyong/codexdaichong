'use strict';

const { chromium } = require('playwright');
const { selectPricingUpgrade } = require('../pricing-plan-selection');

describe('local pricing-page plan selection', () => {
    let browser;
    let page;
    beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 15000);
    beforeEach(async () => { page = await browser.newPage(); });
    afterEach(async () => { await page.close(); });
    afterAll(async () => { await browser.close(); });
    const card = (title, key, price = '') => `<article><h2>${title}</h2><p>${price}</p><button onclick="document.body.dataset.chosen='${key}'">Upgrade</button></article>`;
    const selected = () => page.locator('body').getAttribute('data-chosen');

    it('expands See all plans before selecting Pro 100 and ignores the earlier Plus Upgrade button', async () => {
        await page.setContent(`<main>${card('Free', 'free')}${card('Plus', 'plus')}
            <a href="#" onclick="event.preventDefault();document.getElementById('all').hidden=false;this.remove()">See all plans</a>
            <section id="all" hidden>${card('Pro 100','pro100')}${card('Pro 200','pro200')}${card('Pro 500','pro500')}</section></main>`);
        await selectPricingUpgrade(page, 'pro100');
        expect(await selected()).toBe('pro100');
    });
    it.each(['pro100','pro200','pro500'])('selects exactly %s among multiple Pro cards', async (tier) => {
        await page.setContent(`<main>${card('Plus','plus')}${card('Pro 100','pro100')}${card('Pro 200','pro200')}${card('Pro 500','pro500')}</main>`);
        await selectPricingUpgrade(page, tier);
        expect(await selected()).toBe(tier);
    });
    it('does not substitute another Pro tier or Plus when Pro 100 is missing', async () => {
        await page.setContent(`<main>${card('Plus','plus')}${card('Pro 200','pro200','$200')}</main>`);
        await expect(selectPricingUpgrade(page, 'pro100')).rejects.toThrow(/未显示可确认的目标档位/);
        expect(await selected()).toBeNull();
    });
    it('refuses an ambiguous generic Pro card with local-currency pricing', async () => {
        await page.setContent(`<main>${card('Pro','generic','₱5,500 / month')}</main>`);
        await expect(selectPricingUpgrade(page, 'pro100')).rejects.toThrow(/无法确认/);
        expect(await selected()).toBeNull();
    });
    it('supports an explicit USD price without mistaking the Plus card for Pro', async () => {
        await page.setContent(`<main>${card('Plus','plus','$20')}${card('Pro','pro100','$100 / month')}</main>`);
        await selectPricingUpgrade(page, 'pro100');
        expect(await selected()).toBe('pro100');
    });
    it('rejects duplicate matching plan cards rather than clicking the first one', async () => {
        await page.setContent(`<main>${card('Pro 100','first')}${card('Pro 100','second')}</main>`);
        await expect(selectPricingUpgrade(page, 'pro100')).rejects.toThrow(/多个候选/);
        expect(await selected()).toBeNull();
    });
    it('reads split currency and amount spans inside a Pro price without reading unrelated benefits', async () => {
        await page.setContent(`<main><article><h2>Pro</h2><div><span>$</span><span>100</span><span> / month</span></div>
            <p>Includes benefits worth $500</p><button onclick="document.body.dataset.chosen='pro100'">Get Pro</button></article></main>`);
        await selectPricingUpgrade(page, 'pro100');
        expect(await selected()).toBe('pro100');
    });
    it('preserves Plus selection when the button is labelled Start now', async () => {
        await page.setContent(`<main>${card('Pro 100','pro100')}${card('Plus','plus').replace('>Upgrade<','>Start now<')}</main>`);
        await selectPricingUpgrade(page, 'plus');
        expect(await selected()).toBe('plus');
    });
});
