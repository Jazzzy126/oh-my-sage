import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SettingsStore} from '../../src/server/config/store';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'oms-settings-'));
}

test('未设置环境变量和磁盘配置时返回空配置且不报错', async () => {
    const dir = createTempDir();
    const savedEnv = {
        GATEWAY_URL: process.env.GATEWAY_URL,
        LLM_BASE_URL: process.env.LLM_BASE_URL,
        LLM_API_KEY: process.env.LLM_API_KEY,
        LLM_MODEL: process.env.LLM_MODEL,
        LLM_TEMPERATURE: process.env.LLM_TEMPERATURE,
    };
    delete process.env.GATEWAY_URL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_TEMPERATURE;

    try {
        const store = new SettingsStore(dir);
        const pub = await store.getPublic();
        assert.equal(pub.gatewayUrl, '');
        assert.equal(pub.llmBaseUrl, '');
        assert.equal(pub.llmModel, '');
        assert.equal(pub.hasApiKey, false);
        assert.equal(pub.gatewayConfigured, false);
        assert.equal(pub.llmConfigured, false);
        assert.equal(pub.llmTemperature, 0.2);
        assert.equal(pub.llmProvider, 'openai');
        assert.equal(pub.customInstructions, '');
    } finally {
        Object.assign(process.env, savedEnv);
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('保存配置后可跨实例读取且对 API Key 脱敏、更新时留空保留原 Key', async () => {
    const dir = createTempDir();
    try {
        const store1 = new SettingsStore(dir);
        const saved = await store1.update({
            gatewayUrl: 'http://192.168.1.10/',
            llmBaseUrl: 'https://api.example.com/v1/',
            llmApiKey: 'sk-1234567890abcdef',
            llmModel: 'gpt-4o',
            llmTemperature: 0.5,
        });

        assert.equal(saved.gatewayUrl, 'http://192.168.1.10');
        assert.equal(saved.llmBaseUrl, 'https://api.example.com/v1');
        assert.equal(saved.hasApiKey, true);
        assert.equal(saved.apiKeyMasked, 'sk-••••cdef');
        assert.equal(saved.gatewayConfigured, true);
        assert.equal(saved.llmConfigured, true);

        // 模拟新实例（不同请求/重启后）读取同一服务端文件
        const store2 = new SettingsStore(dir);
        const modelCfg = await store2.getModelConfig();
        assert.equal(modelCfg.apiKey, 'sk-1234567890abcdef');
        assert.equal(modelCfg.model, 'gpt-4o');
        assert.equal(modelCfg.temperature, 0.5);

        // 仅改模型名时不传 llmApiKey，应保留原 Key
        const updated = await store2.update({llmModel: 'gpt-4.1', customInstructions: '偏好简短命名'});
        assert.equal(updated.llmModel, 'gpt-4.1');
        assert.equal(updated.customInstructions, '偏好简短命名');
        assert.equal(updated.hasApiKey, true);
        assert.equal((await store2.getModelConfig()).apiKey, 'sk-1234567890abcdef');

        // 安全防护：修改已配置的 llmBaseUrl 但不重新输入 llmApiKey 时拒绝保存，防止原 Key 外泄
        await assert.rejects(
            () => store2.update({llmBaseUrl: 'https://evil.example.com/v1'}),
            /必须重新输入 API Key/
        );

        // 同时提供新 llmBaseUrl 与新 llmApiKey 时允许更新
        const migrated = await store2.update({
            llmBaseUrl: 'https://api2.example.com/v1',
            llmApiKey: 'sk-newkey987654321',
        });
        assert.equal(migrated.llmBaseUrl, 'https://api2.example.com/v1');
        assert.equal((await store2.getModelConfig()).apiKey, 'sk-newkey987654321');

        // 显式清空 Key
        const cleared = await store2.update({clearApiKey: true});
        assert.equal(cleared.hasApiKey, false);
        assert.equal(cleared.llmConfigured, false);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('非法 URL 或 Temperature 抛出明确错误', async () => {
    const dir = createTempDir();
    try {
        const store = new SettingsStore(dir);
        await assert.rejects(
            () => store.update({gatewayUrl: 'not-a-url'}),
            /格式无效/
        );
        await assert.rejects(
            () => store.update({llmTemperature: 3}),
            /0 到 2/
        );

        // 已保存 Key 时单独修改 Base URL 必须报错拦截，防止密钥被重定向泄露
        await store.update({
            llmBaseUrl: 'https://api.openai.com/v1',
            llmApiKey: 'sk-secret-key-1234',
            llmModel: 'gpt-4o',
        });
        await assert.rejects(
            () => store.update({llmBaseUrl: 'https://evil.example.com/v1'}),
            /重新输入 API Key/
        );
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});
