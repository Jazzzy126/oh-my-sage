/**
 * 服务端运行时配置存储
 * 将网关地址与 AI 模型配置持久化在服务端（.sessionstore/settings.json），
 * 一次配置后多端/多浏览器共享，不依赖启动前预设环境变量。
 */

import {promises as fsp} from 'fs';
import path from 'path';
import type {ModelConfig} from '@/server/ai/model';

// ==================== 类型定义 ====================

/**
 * 持久化在服务端的完整配置（含敏感字段）
 */
export interface RuntimeSettings {
    gatewayUrl: string;
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    llmTemperature: number;
}

/**
 * 返回给前端的脱敏配置
 */
export interface PublicSettings {
    gatewayUrl: string;
    llmBaseUrl: string;
    llmModel: string;
    llmTemperature: number;
    hasApiKey: boolean;
    apiKeyMasked: string;
    gatewayConfigured: boolean;
    llmConfigured: boolean;
}

/**
 * 更新配置入参
 */
export interface SettingsPatch {
    gatewayUrl?: string;
    llmBaseUrl?: string;
    llmApiKey?: string;
    clearApiKey?: boolean;
    llmModel?: string;
    llmTemperature?: number;
}

// ==================== 工具函数 ====================

const DEFAULT_TEMPERATURE = 0.7;

function normalizeHttpUrl(raw: string, fieldName: string): string {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`${fieldName} 格式无效，请填写完整的 http:// 或 https:// 地址`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${fieldName} 仅支持 http:// 或 https:// 协议`);
    }
    return trimmed;
}

function maskApiKey(apiKey: string): string {
    const trimmed = apiKey.trim();
    if (!trimmed) return '';
    if (trimmed.length <= 8) return '••••••••';
    const prefix = trimmed.slice(0, 3);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••${suffix}`;
}

function parseTemperature(raw: unknown, fallback = DEFAULT_TEMPERATURE): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 2) {
        throw new Error('Temperature 必须是 0 到 2 之间的数字');
    }
    return Math.round(num * 100) / 100;
}

// ==================== Store 实现 ====================

export class SettingsStore {
    private filePath: string;
    private cache: RuntimeSettings | null = null;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(baseDir: string = '.sessionstore', fileName: string = 'settings.json') {
        this.filePath = path.resolve(process.cwd(), baseDir, fileName);
    }

    /**
     * 读取磁盘中保存的配置（不包含环境变量兜底）
     */
    async readStored(): Promise<Partial<RuntimeSettings>> {
        if (this.cache) {
            return {...this.cache};
        }
        try {
            const raw = await fsp.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
            if (!parsed || typeof parsed !== 'object') return {};
            return {
                gatewayUrl: typeof parsed.gatewayUrl === 'string' ? parsed.gatewayUrl : '',
                llmBaseUrl: typeof parsed.llmBaseUrl === 'string' ? parsed.llmBaseUrl : '',
                llmApiKey: typeof parsed.llmApiKey === 'string' ? parsed.llmApiKey : '',
                llmModel: typeof parsed.llmModel === 'string' ? parsed.llmModel : '',
                llmTemperature: typeof parsed.llmTemperature === 'number' && Number.isFinite(parsed.llmTemperature)
                    ? parsed.llmTemperature
                    : DEFAULT_TEMPERATURE,
            };
        } catch {
            return {};
        }
    }

    /**
     * 获取当前生效配置（服务端持久化优先，环境变量仅作可选兜底）
     */
    async getEffective(): Promise<RuntimeSettings> {
        const stored = await this.readStored();
        const envTemp = process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : NaN;
        const fallbackTemp = Number.isFinite(envTemp) ? envTemp : DEFAULT_TEMPERATURE;

        const effective: RuntimeSettings = {
            gatewayUrl: stored.gatewayUrl || (process.env.GATEWAY_URL || '').trim().replace(/\/+$/, ''),
            llmBaseUrl: stored.llmBaseUrl || (process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, ''),
            llmApiKey: stored.llmApiKey || (process.env.LLM_API_KEY || '').trim(),
            llmModel: stored.llmModel || (process.env.LLM_MODEL || '').trim(),
            llmTemperature: stored.llmTemperature ?? fallbackTemp,
        };
        this.cache = effective;
        return {...effective};
    }

    /**
     * 返回给前端的脱敏配置
     */
    async getPublic(): Promise<PublicSettings> {
        const effective = await this.getEffective();
        return toPublicSettings(effective);
    }

    /**
     * 更新配置并串行落盘
     */
    async update(patch: SettingsPatch): Promise<PublicSettings> {
        const run = this.writeQueue.then(async () => {
            const current = await this.getEffective();
            const next: RuntimeSettings = {
                gatewayUrl: patch.gatewayUrl !== undefined
                    ? normalizeHttpUrl(patch.gatewayUrl, '网关地址')
                    : current.gatewayUrl,
                llmBaseUrl: patch.llmBaseUrl !== undefined
                    ? normalizeHttpUrl(patch.llmBaseUrl, 'API Base URL')
                    : current.llmBaseUrl,
                llmApiKey: patch.clearApiKey
                    ? ''
                    : patch.llmApiKey !== undefined && patch.llmApiKey.trim() !== ''
                        ? patch.llmApiKey.trim()
                        : current.llmApiKey,
                llmModel: patch.llmModel !== undefined
                    ? patch.llmModel.trim()
                    : current.llmModel,
                llmTemperature: patch.llmTemperature !== undefined
                    ? parseTemperature(patch.llmTemperature, current.llmTemperature)
                    : current.llmTemperature,
            };

            await fsp.mkdir(path.dirname(this.filePath), {recursive: true});
            await fsp.writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8');
            this.cache = next;
            return toPublicSettings(next);
        });

        this.writeQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * 获取当前生效的 AI 模型配置
     */
    async getModelConfig(): Promise<ModelConfig> {
        const effective = await this.getEffective();
        return {
            baseURL: effective.llmBaseUrl,
            apiKey: effective.llmApiKey,
            model: effective.llmModel,
            temperature: effective.llmTemperature,
        };
    }
}

export function toPublicSettings(settings: RuntimeSettings): PublicSettings {
    const hasApiKey = Boolean(settings.llmApiKey);
    return {
        gatewayUrl: settings.gatewayUrl,
        llmBaseUrl: settings.llmBaseUrl,
        llmModel: settings.llmModel,
        llmTemperature: settings.llmTemperature,
        hasApiKey,
        apiKeyMasked: maskApiKey(settings.llmApiKey),
        gatewayConfigured: Boolean(settings.gatewayUrl),
        llmConfigured: Boolean(settings.llmBaseUrl && settings.llmApiKey && settings.llmModel),
    };
}

// ==================== 全局单例 ====================

const globalKey = '__oh_my_sage_settings_store__';

export function getSettingsStore(): SettingsStore {
    const g = globalThis as Record<string, unknown>;
    if (!g[globalKey]) {
        g[globalKey] = new SettingsStore();
    }
    return g[globalKey] as SettingsStore;
}
