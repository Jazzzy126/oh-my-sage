/**
 * 认证 API
 * 只负责网关认证，不获取设备
 */

import {NextRequest, NextResponse} from 'next/server';
import {connectGateway, disconnectGateway, isGatewayConnected} from '@/server/gateway/shared';

export const runtime = 'nodejs';

/**
 * GET /api/auth
 * 查询服务端网关是否已连接（用于页面刷新后自动恢复登录态）
 */
export async function GET() {
    return NextResponse.json({
        success: true,
        connected: isGatewayConnected(),
    });
}

/**
 * POST /api/auth
 * 登录并建立网关连接
 */
export async function POST(request: NextRequest) {
    try {
        const {passcode} = await request.json();

        if (typeof passcode !== 'string' || !/^\d{6}$/.test(passcode)) {
            return NextResponse.json({
                success: false,
                error: '登录码格式错误',
                message: '请提供6位数字登录码',
            }, {status: 400});
        }

        if (!process.env.GATEWAY_URL) {
            return NextResponse.json({success: false, error: '未配置网关地址', message: '请在服务端设置 GATEWAY_URL'}, {status: 400});
        }
        await connectGateway(passcode);

        return NextResponse.json({
            success: true,
            message: '成功连接到网关',
        });
    } catch (error) {
        console.error('认证失败:', error);
        const message = error instanceof Error ? error.message : '未知错误';
        return NextResponse.json({
            success: false,
            error: '认证失败',
            message,
        }, {status: /认证|登录码/.test(message) ? 401 : 502});
    }
}

/**
 * DELETE /api/auth
 * 断开当前网关连接，退出到登录页重新填写登录码
 */
export async function DELETE() {
    try {
        await disconnectGateway();
        return NextResponse.json({
            success: true,
            message: '已断开网关连接',
        });
    } catch (error) {
        console.error('断开网关连接失败:', error);
        const message = error instanceof Error ? error.message : '未知错误';
        return NextResponse.json({
            success: false,
            error: '断开连接失败',
            message,
        }, {status: 500});
    }
}
