'use strict';

const { extractProfileFromToken } = require('./session-auth');
const { checkoutError, responseDiagnostic } = require('./checkout-api-diagnostic');

const SESSION_URL = 'https://chatgpt.com/api/auth/session';
const SESSION_TIMEOUT_MS = 15000;

function identityFromUser(user) {
    return {
        userId: typeof user?.id === 'string' ? user.id.trim() : '',
        email: typeof user?.email === 'string' ? user.email.trim().toLowerCase() : ''
    };
}

function identityFromToken(token) {
    const profile = extractProfileFromToken(token);
    return {
        userId: String(profile.userId || '').trim(),
        email: String(profile.email || '').trim().toLowerCase()
    };
}

// Workspace/account IDs are deliberately excluded from user identity checks.
function compareIdentity(expected, actual) {
    if (expected.userId && actual.userId) return expected.userId === actual.userId;
    if (expected.email && actual.email) return expected.email === actual.email;
    return null;
}

function validateFreshToken(token, session) {
    if (!token || /\s/.test(token)) return 'SESSION_TOKEN_INVALID';
    if (token.includes('.')) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3 || parts.some((part) => !part)) return 'SESSION_TOKEN_INVALID';
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            const expiry = Number(claims.exp);
            if (!Number.isFinite(expiry) || expiry <= 0) return 'SESSION_TOKEN_INVALID';
            if (expiry <= Date.now() / 1000) return 'SESSION_TOKEN_EXPIRED';
        } catch (_) { return 'SESSION_TOKEN_INVALID'; }
    }
    if (session.expires != null) {
        const expires = Date.parse(session.expires);
        if (!Number.isFinite(expires)) return 'SESSION_TOKEN_INVALID';
        if (expires <= Date.now()) return 'SESSION_TOKEN_EXPIRED';
    }
    return '';
}

async function readCheckoutSession(request, { accessToken, sessionData } = {}) {
    const started = Date.now();
    const secrets = [accessToken];
    let response;
    try {
        // APIRequestContext shares cookies/proxy with the browser, but bypasses
        // the page's mocked /api/auth/session fetch/route responses.
        response = await request.get(SESSION_URL, {
            headers: { Accept: 'application/json' },
            timeout: SESSION_TIMEOUT_MS,
            maxRetries: 0,
            maxRedirects: 0
        });
    } catch (error) {
        const diagnostic = responseDiagnostic({
            phase: 'session-check', message: error.message || '无法读取真实登录会话',
            code: /timeout|timed out/i.test(error.message || '') ? 'SESSION_TIMEOUT' : 'SESSION_REQUEST_FAILED',
            type: 'network', latencyMs: Date.now() - started, secrets
        });
        throw checkoutError('API 会话校验失败: ' + diagnostic.message, diagnostic, secrets);
    }
    const status = response.status();
    const headers = typeof response.headers === 'function' ? response.headers() : {};
    let data;
    try { data = JSON.parse(await response.text()); } catch (_) { data = null; }
    const token = typeof data?.accessToken === 'string' ? data.accessToken.trim()
        : typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    secrets.push(token);
    const fail = (code, message) => {
        const diagnostic = responseDiagnostic({ phase: 'session-check', status, headers,
            code, type: 'authentication', message, latencyMs: Date.now() - started, secrets });
        throw checkoutError('API 会话校验失败: ' + message, diagnostic, secrets);
    };
    if (status !== 200) fail('SESSION_HTTP_ERROR', `真实会话接口返回 HTTP ${status}`);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.user
        || typeof data.user !== 'object' || Array.isArray(data.user)) {
        fail('SESSION_INVALID', '真实会话未返回有效用户信息');
    }
    const tokenError = validateFreshToken(token, data);
    if (tokenError) fail(tokenError, tokenError === 'SESSION_TOKEN_EXPIRED'
        ? '真实会话返回的 AccessToken 已过期' : '真实会话未返回有效 AccessToken');
    const actualIdentity = identityFromUser(data.user);
    if (!actualIdentity.userId && !actualIdentity.email) fail('SESSION_INVALID', '真实会话缺少用户身份');
    const tokenIdentity = identityFromToken(token);
    if (compareIdentity(tokenIdentity, actualIdentity) === false) {
        fail('SESSION_IDENTITY_MISMATCH', '真实会话用户与其 AccessToken 身份不一致');
    }
    const expectedIdentities = [identityFromUser(sessionData?.user), identityFromToken(accessToken)];
    const comparisons = expectedIdentities.map((expected) => compareIdentity(expected, actualIdentity));
    if (comparisons.includes(false)) {
        fail('SESSION_IDENTITY_MISMATCH', 'Cookie 会话与导入凭据的用户身份不一致');
    }
    if (!comparisons.includes(true)) fail('SESSION_IDENTITY_UNVERIFIED', '无法核对 Cookie 会话与导入凭据的用户身份');
    return { accessToken: token, user: data.user };
}

module.exports = { readCheckoutSession, SESSION_TIMEOUT_MS };
