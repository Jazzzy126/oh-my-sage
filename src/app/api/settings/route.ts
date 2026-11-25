/**
 * 运行时配置 API
 * GET /api/settings - 获取脱敏后的当前配置
 * PUT /api/settings - 更新并持久化网关与 AI 模型配置
 */

import {NextRequest, NextResponse} from 'next/server';
import {getSettingsStore, type SettingsPatch} from '@/server/config/store';

export const runtime = 'nodejs';

export async function GET() {
    try {
        const settings = await getSettingsStore().getPublic();
        return NextResponse.json({
            success: true,
            settings,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : '读取配置失败';
        return NextResponse.json({success: false, error: message}, {status: 500});
    }
}

export async function PUT(request: NextRequest) {
    try {
        const body = (await request.json()) as Record<string, unknown>;
        const patch: SettingsPatch = {};

        if (typeof body.gatewayUrl === 'string') patch.gatewayUrl = body.gatewayUrl;
        if (typeof body.llmBaseUrl === 'string') patch.llmBaseUrl = body.llmBaseUrl;
        if (typeof body.llmApiKey === 'string') patch.llmApiKey = body.llmApiKey;
        if (typeof body.clearApiKey === 'boolean') patch.clearApiKey = body.clearApiKey;
        if (typeof body.llmModel === 'string') patch.llmModel = body.llmModel;
        if (body.llmTemperature !== undefined) {
            patch.llmTemperature = typeof body.llmTemperature === 'number'
                ? body.llmTemperature
                : Number(body.llmTemperature);
        }

        const settings = await getSettingsStore().update(patch);
        return NextResponse.json({
            success: true,
            settings,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : '保存配置失败';
        return NextResponse.json({success: false, error: message}, {status: 400});
    }
}
