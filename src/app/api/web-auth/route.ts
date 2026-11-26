/**
 * Web 访问口令验证 API
 * GET    /api/web-auth - 查询是否开启了 WEB_ACCESS_TOKEN 保护及当前是否已通过验证
 * POST   /api/web-auth - 验证访问口令并下发 HttpOnly Cookie
 * DELETE /api/web-auth - 清除 Web 访问 Cookie
 */

import {NextRequest, NextResponse} from 'next/server';
import {
    WEB_AUTH_COOKIE,
    deriveAuthCookieValue,
    getConfiguredWebToken,
    isWebAuthRequired,
    safeCompareSecret,
    verifyWebRequestAuth,
} from '@/server/auth/webAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const required = isWebAuthRequired();
    const authenticated = verifyWebRequestAuth({
        cookieValue: request.cookies.get(WEB_AUTH_COOKIE)?.value,
        authorizationHeader: request.headers.get('authorization'),
    });

    return NextResponse.json({
        success: true,
        required,
        authenticated,
    });
}

export async function POST(request: NextRequest) {
    const expected = getConfiguredWebToken();
    if (!expected) {
        return NextResponse.json({success: true, required: false, authenticated: true});
    }

    try {
        const body = (await request.json()) as {token?: unknown};
        const provided = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!provided || !safeCompareSecret(provided, expected)) {
            return NextResponse.json(
                {success: false, error: '访问密码错误'},
                {status: 401}
            );
        }

        const response = NextResponse.json({
            success: true,
            required: true,
            authenticated: true,
        });
        response.cookies.set(WEB_AUTH_COOKIE, deriveAuthCookieValue(expected), {
            httpOnly: true,
            sameSite: 'lax',
            secure: request.nextUrl.protocol === 'https:',
            path: '/',
            maxAge: 60 * 60 * 24 * 30, // 30 天
        });
        return response;
    } catch {
        return NextResponse.json({success: false, error: '请求格式无效'}, {status: 400});
    }
}

export async function DELETE() {
    const response = NextResponse.json({success: true});
    response.cookies.delete(WEB_AUTH_COOKIE);
    return response;
}
