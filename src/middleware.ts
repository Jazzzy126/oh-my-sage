/**
 * Next.js API 访问鉴权中间件（Web Crypto 实现，兼容 Edge Runtime）
 * 当环境变量设置了 WEB_ACCESS_TOKEN 时，拦截所有未携带有效凭证的 /api/* 请求（/api/web-auth 除外）。
 */

import {NextRequest, NextResponse} from 'next/server';

const WEB_AUTH_COOKIE = 'oms_web_auth';
const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        {name: 'HMAC', hash: 'SHA-256'},
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
    if (!a || !b) return false;
    const [hashA, hashB] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(a)),
        crypto.subtle.digest('SHA-256', encoder.encode(b)),
    ]);
    const viewA = new Uint8Array(hashA);
    const viewB = new Uint8Array(hashB);
    if (viewA.length !== viewB.length) return false;
    let diff = 0;
    for (let i = 0; i < viewA.length; i++) {
        diff |= viewA[i] ^ viewB[i];
    }
    return diff === 0;
}

export async function middleware(request: NextRequest) {
    const expectedToken = (process.env.WEB_ACCESS_TOKEN || '').trim();
    if (!expectedToken) {
        return NextResponse.next();
    }

    const {pathname} = request.nextUrl;
    if (pathname === '/api/web-auth') {
        return NextResponse.next();
    }

    const cookieVal = request.cookies.get(WEB_AUTH_COOKIE)?.value;
    if (cookieVal) {
        const expectedCookie = await hmacHex('oh-my-sage-web-auth-v1', expectedToken);
        if (await constantTimeEqual(cookieVal, expectedCookie)) {
            return NextResponse.next();
        }
    }

    const authHeader = request.headers.get('authorization');
    if (authHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
        if (match && (await constantTimeEqual(match[1], expectedToken))) {
            return NextResponse.next();
        }
    }

    return NextResponse.json(
        {
            success: false,
            webAuthRequired: true,
            error: '未授权访问，请先输入 Web 访问密码',
        },
        {status: 401}
    );
}

export const config = {
    matcher: ['/api/:path*'],
};
