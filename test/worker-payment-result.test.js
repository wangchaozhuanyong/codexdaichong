'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extract(filename, start, end) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8').replace(/\r\n/g, '\n');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + 1);
    if (from < 0 || to < 0) throw new Error(`Missing worker test boundary in ${filename}`);
    return source.slice(from, to);
}

const parse = vm.runInNewContext([
    extract('server.js', 'function withoutCheckoutApiDiagnostics(', '// Parse only bounded worker markers'),
    extract('server.js', 'function extractRuntimeErrorMessage(', 'function getCheckoutProgress('),
    'analyzeProcessOutput'
].join('\n'));

const unknownMessage = '付款结果待核实，已转人工确认，请勿重复充值，请联系客服处理。';

describe('worker payment result handoff', () => {
    it('keeps the latest unknown result manual even when earlier output matched decline, success or retry', () => {
        const output = [
            '银行卡被拒绝',
            '未确认支付成功',
            'You have been blocked',
            'PAYMENT_RESULT_UNKNOWN',
            '❌ [运行时错误]: 支付失败 (manual_intervention)'
        ].join('\r\n');

        expect(parse(output, false)).toEqual({
            status: 'manual',
            message: unknownMessage,
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        });
    });

    it.each([
        'prefix PAYMENT_RESULT_UNKNOWN',
        'PAYMENT_RESULT_UNKNOWN suffix',
        'PAYMENT_RESULT_UNKNOWN_EXTRA',
        ' PAYMENT_RESULT_UNKNOWN',
        'PAYMENT_RESULT_UNKNOWN ',
        'prefix\u2028PAYMENT_RESULT_UNKNOWN\u2028suffix',
        'CHECKOUT_API_RESULT: {"diagnostic":{"message":"PAYMENT_RESULT_UNKNOWN"}}'
    ])('preserves explicit decline when the marker appears only inside %s', (line) => {
        expect(parse(`银行卡被拒绝\n${line}`, false)).toMatchObject({
            status: 'manual',
            message: '银行卡被拒绝或 Stripe 驳回，请查看截图后人工处理',
            shouldRetry: false,
            deleteCard: true
        });
    });

    it('leaves legacy success and text-only uncertainty classifications unchanged', () => {
        expect(parse('PAYMENT_SUCCESS', false).status).toBe('success');
        expect(parse('支付结果等待超时', false)).toMatchObject({
            status: 'manual', message: '支付结果未确认，请查看截图后人工处理', shouldRetry: false
        });
    });

});
