/**
 * Web 访问鉴权工具（可选启用）
 * 当设置了环境变量 WEB_ACCESS_TOKEN 时，外网穿透访问所有 API 均需携带有效 Cookie 或 Bearer Token。
 * 未设置 WEB_ACCESS_TOKEN 时默认放行，保持纯局域网部署零门槛体验。
 */

import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export const WEB_AUTH_COOKIE = 'oms_web_auth';

/**
 * 获取当前配置的 Web 访问口令（去除首尾空白）
 */
export function getConfiguredWebToken(): string {
    return (process.env.WEB_ACCESS_TOKEN || '').trim();
}

/**
 * 当前环境是否启用了 Web 访问口令保护
 */
export function isWebAuthRequired(): boolean {
    return getConfiguredWebToken().length > 0;
}

/**
 * 根据访问口令派生 Cookie 签名值（避免在 Cookie 中直接存明文口令）
 */
export function deriveAuthCookieValue(token: string): string {
    return createHmac('sha256', 'oh-my-sage-web-auth-v1').update(token).digest('hex');
}

/**
 * 常量时间字符串比对，防止时序侧信道探测口令
 */
export function safeCompareSecret(provided: string, expected: string): boolean {
    if (!provided || !expected) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

/**
 * 校验请求头/Cookie 是否通过 Web 访问鉴权
 */
export function verifyWebRequestAuth(options: {
    cookieValue?: string;
    authorizationHeader?: string | null;
}): boolean {
    const expectedToken = getConfiguredWebToken();
    if (!expectedToken) return true;

    if (options.cookieValue) {
        const expectedCookie = deriveAuthCookieValue(expectedToken);
        if (safeCompareSecret(options.cookieValue, expectedCookie)) {
            return true;
        }
    }

    if (options.authorizationHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(options.authorizationHeader.trim());
        if (match && safeCompareSecret(match[1], expectedToken)) {
            return true;
        }
    }

    return false;
}
