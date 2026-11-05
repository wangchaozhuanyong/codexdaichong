'use strict';

const { redactSensitiveText } = require('./gpt-api-failure');
const PHASES = new Set(['session-check', 'checkout-create', 'checkout-page']);

function safeText(value, maxLength = 1600, secrets = [], identifier = false) {
    if (value == null || !['string', 'number', 'boolean'].includes(typeof value)) return '';
    let text = String(value);
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret) text = text.split(secret).join('[已隐藏凭据]');
    }
    // NextAuth session cookies may be compact encrypted JWTs (five segments).
    text = text.replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[已隐藏令牌]');
    return redactSensitiveText(text, maxLength, { skipPanHeuristic: identifier });
}

function sanitizeCheckoutDiagnostic(input, secrets = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const scalarNumber = (value) => typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    const status = scalarNumber(input.httpStatus);
    const latency = scalarNumber(input.latencyMs);
    return {
        phase: PHASES.has(input.phase) ? input.phase : 'checkout-create',
        httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        code: safeText(input.code, 120, secrets, true),
        type: safeText(input.type, 120, secrets, true),
        message: safeText(input.message, 1600, secrets),
        requestId: safeText(input.requestId, 120, secrets, true),
        retryAfter: safeText(input.retryAfter, 120, secrets, true),
        latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.min(3600000, Math.round(latency)) : 0
    };
}

function readHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return '';
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
    return key ? headers[key] : '';
}

function firstScalar(values) {
    return values.find((value) => ['string', 'number', 'boolean'].includes(typeof value)
        && String(value).trim()) ?? '';
}

function responseDiagnostic({ phase = 'checkout-create', status, data, headers, message, code, type,
    latencyMs = 0, secrets = [] }) {
    const root = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const detail = root.detail && typeof root.detail === 'object' && !Array.isArray(root.detail) ? root.detail : {};
    const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error : {};
    return sanitizeCheckoutDiagnostic({
        phase,
        httpStatus: status,
        code: firstScalar([detail.code, error.code, root.code, code]),
        type: firstScalar([detail.type, error.type, root.type, type]),
        message,
        requestId: firstScalar([
            readHeader(headers, 'x-request-id'), readHeader(headers, 'request-id'),
            readHeader(headers, 'cf-ray'), detail.request_id, error.request_id, root.request_id
        ]),
        retryAfter: readHeader(headers, 'retry-after'),
        latencyMs
    }, secrets);
}

function checkoutError(message, diagnostic, secrets = []) {
    const error = new Error(safeText(message, 1800, secrets));
    error.diagnostic = sanitizeCheckoutDiagnostic(diagnostic, secrets);
    return error;
}

module.exports = {
    safeText,
    sanitizeCheckoutDiagnostic,
    responseDiagnostic,
    checkoutError
};
