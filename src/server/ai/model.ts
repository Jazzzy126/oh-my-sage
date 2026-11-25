/**
 * oh-my-sage - AI 模型配置
 * 仅支持 OpenAI 兼容接口
 */

import {createOpenAI} from '@ai-sdk/openai';
import {generateText} from 'ai';

/**
 * 模型配置
 */
export interface ModelConfig {
    /** API 地址 */
    baseURL: string;
    /** API Key */
    apiKey: string;
    /** 模型名称 */
    model: string;
    /** 温度（可选，默认 0.7） */
    temperature?: number;
}

/**
 * 创建模型实例
 */
export function createModel(config: ModelConfig) {
    if (!config.baseURL) throw new Error('缺少 API Base URL 配置');
    if (!config.apiKey) throw new Error('缺少 API Key 配置');
    if (!config.model) throw new Error('缺少模型名称配置');

    return createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
    })(config.model);
}

/**
 * 从环境变量读取模型配置
 *
 * 环境变量：
 *   LLM_BASE_URL  - API 地址，如 https://api.openai.com/v1
 *   LLM_API_KEY   - API Key
 *   LLM_MODEL     - 模型名称，如 gpt-6.1-terra
 */
export function getModelConfigFromEnv(): ModelConfig {
    return {
        baseURL: process.env.LLM_BASE_URL || '',
        apiKey: process.env.LLM_API_KEY || '',
        model: process.env.LLM_MODEL || '',
        temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
    };
}

/**
 * 模型连通性测试结果
 */
export interface ModelConnectionTestResult {
    success: boolean;
    latencyMs: number;
    model: string;
    error?: string;
}

/**
 * 提取可读的模型调用错误信息
 */
function formatConnectionError(error: unknown): string {
    if (error instanceof Error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            return '请求超时，请检查 API Base URL 是否可达';
        }
        const anyErr = error as Error & {statusCode?: number; cause?: unknown};
        if (typeof anyErr.statusCode === 'number') {
            return `HTTP ${anyErr.statusCode}: ${error.message}`;
        }
        return error.message;
    }
    return '连接模型失败';
}

/**
 * 测试 AI 模型配置连通性（发送一次极简文本生成请求）
 */
export async function testModelConnection(
    config: ModelConfig,
    options?: {timeoutMs?: number}
): Promise<ModelConnectionTestResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? 15000;

    try {
        const model = createModel(config);
        await generateText({
            model,
            prompt: 'Reply with OK.',
            maxTokens: 16,
            abortSignal: AbortSignal.timeout(timeoutMs),
        });
        return {
            success: true,
            latencyMs: Date.now() - start,
            model: config.model,
        };
    } catch (error) {
        return {
            success: false,
            latencyMs: Date.now() - start,
            model: config.model,
            error: formatConnectionError(error),
        };
    }
}
