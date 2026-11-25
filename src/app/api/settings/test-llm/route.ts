/**
 * AI 模型连通性测试 API
 * POST /api/settings/test-llm - 使用表单中的配置（或已保存的 API Key）测试模型接口连通性
 */

import {NextRequest, NextResponse} from 'next/server';
import {testModelConnection} from '@/server/ai/model';
import {getSettingsStore} from '@/server/config/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeBaseUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) {
        throw new Error('请填写 API Base URL');
    }
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error('API Base URL 格式无效，请填写完整的 http:// 或 https:// 地址');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('API Base URL 仅支持 http:// 或 https:// 协议');
    }
    return trimmed;
}

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as Record<string, unknown>;
        const rawBaseUrl = typeof body.llmBaseUrl === 'string' ? body.llmBaseUrl : '';
        const rawApiKey = typeof body.llmApiKey === 'string' ? body.llmApiKey.trim() : '';
        const rawModel = typeof body.llmModel === 'string' ? body.llmModel.trim() : '';
        const clearApiKey = body.clearApiKey === true;

        const baseURL = normalizeBaseUrl(rawBaseUrl);
        if (!rawModel) {
            return NextResponse.json({success: false, error: '请填写模型名称'}, {status: 400});
        }

        let apiKey = rawApiKey;
        if (!apiKey && !clearApiKey) {
            const effective = await getSettingsStore().getEffective();
            apiKey = effective.llmApiKey;
        }
        if (!apiKey) {
            return NextResponse.json({success: false, error: '请填写 API Key'}, {status: 400});
        }

        const result = await testModelConnection({
            baseURL,
            apiKey,
            model: rawModel,
        });

        return NextResponse.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : '测试连通性失败';
        return NextResponse.json({success: false, error: message}, {status: 400});
    }
}
