import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    Agent,
    isUserRejectionInput,
    resolveAllowedMutations,
    summarizeToolCallsForCompression,
} from '../../src/server/agent/agent';
import { deriveAuthCookieValue, verifyWebRequestAuth } from '../../src/server/auth/webAuth';
import { createCoreTools, MAX_WEB_TOOL_RESULT_BYTES } from '../../src/server/ai/tools-adapter';
import { SessionStore } from '../../src/server/session/store';
import { clearSkillsCache, getSkillCatalog } from '../../src/server/skills/loader';
import type { GatewayClient } from '../../src/core/gateway/client';

test('Web 访问鉴权：未配置 WEB_ACCESS_TOKEN 时放行，配置后校验 Cookie 与 Bearer Token', () => {
    const prev = process.env.WEB_ACCESS_TOKEN;
    try {
        delete process.env.WEB_ACCESS_TOKEN;
        assert.equal(verifyWebRequestAuth({}), true);

        process.env.WEB_ACCESS_TOKEN = 'my-secret-pass-2026';
        assert.equal(verifyWebRequestAuth({}), false);
        assert.equal(verifyWebRequestAuth({ authorizationHeader: 'Bearer wrong' }), false);
        assert.equal(verifyWebRequestAuth({ authorizationHeader: 'Bearer my-secret-pass-2026' }), true);

        const validCookie = deriveAuthCookieValue('my-secret-pass-2026');
        assert.equal(verifyWebRequestAuth({ cookieValue: validCookie }), true);
        assert.equal(verifyWebRequestAuth({ cookieValue: 'tampered' }), false);
    } finally {
        if (prev === undefined) delete process.env.WEB_ACCESS_TOKEN;
        else process.env.WEB_ACCESS_TOKEN = prev;
    }
});

test('SessionStore：拦截路径穿越非法 ID，并清洗会话标题中的 DID/规则 ID 元数据', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-session-sec-'));
    try {
        const store = new SessionStore(dir);
        assert.equal(SessionStore.isValidSessionId('session_170000_abc'), true);
        assert.equal(SessionStore.isValidSessionId('../etc/passwd'), false);
        assert.equal(SessionStore.isValidSessionId('a/b'), false);

        await assert.rejects(() => store.getMessages('../secret'), /非法的 Session ID/);
        await assert.rejects(() => store.deleteSession('..\\secret'), /非法的 Session ID/);

        const session = await store.createSession();
        await store.appendMessage(session.id, {
            role: 'user',
            content: '帮我查看「过道人在传感器」（DID: 1001）的状态',
            timestamp: new Date().toISOString(),
        });
        const meta = await store.getSessionMeta(session.id);
        assert.equal(meta?.title, '查看「过道人在传感器」的状态');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('确认守卫：用户回复取消时全部拦截；创建确认后不允许越权执行 delete', () => {
    assert.equal(isUserRejectionInput('取消'), true);
    assert.equal(isUserRejectionInput('取消，先看看客厅灯'), true);
    assert.equal(isUserRejectionInput('算了不用了'), true);
    assert.equal(isUserRejectionInput('cancel'), true);
    assert.equal(isUserRejectionInput('确认创建'), false);
    assert.equal(isUserRejectionInput('方案1'), false);

    const createAsk = { question: '确认创建以下新规则吗？', options: ['方案1：创建', '取消'] };
    assert.equal(resolveAllowedMutations(createAsk, '取消').size, 0);

    const allowedForCreate = resolveAllowedMutations(createAsk, '方案1：创建');
    assert.equal(allowedForCreate.has('create'), true);
    assert.equal(allowedForCreate.has('modify'), true);
    assert.equal(allowedForCreate.has('delete'), false, '非删除确认不得开放 delete 权限');

    const deleteAsk = { question: '确认删除规则「夜灯」吗？', options: ['确认删除', '取消'] };
    const allowedForDelete = resolveAllowedMutations(deleteAsk, '确认删除');
    assert.equal(allowedForDelete.has('delete'), true);
});

test('Skill 领域过滤：smart-home 过滤排除 frontend-design 等开发类 Skill', () => {
    clearSkillsCache();
    const smartHomeSkills = getSkillCatalog({ domainFilter: 'smart-home' });
    assert.equal(smartHomeSkills.some(s => s.name === 'mijia-automation'), true);
    assert.equal(smartHomeSkills.some(s => s.name === 'frontend-design'), false);
});

test('上下文压缩工具摘要保留设备 DID 与规则 ID', () => {
    const summary = summarizeToolCallsForCompression([
        {
            tool: 'get_devices',
            args: {},
            result: { success: true, data: [{ name: '客厅灯', did: 'd100' }] },
            success: true,
        },
        {
            tool: 'create_graph',
            args: { name: '测试规则' },
            result: { success: true, data: { graphId: '1700000000123' } },
            success: true,
        },
    ]);
    assert.match(summary, /客厅灯:d100/);
    assert.match(summary, /graphId=1700000000123/);
});

test('Agent 流式区分过渡思考与实时正文，并按真实多步序列重放且屏蔽重复 Skill 正文', async () => {
    let step = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const cur = step++;
            if (cur === 0) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '先查设备列表' }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 's1', type: 'function', function: { name: 'activate_skill', arguments: JSON.stringify({ name: 'mijia-automation' }) } }] }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            } else if (cur === 1) {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 's2', type: 'function', function: { name: 'activate_skill', arguments: JSON.stringify({ name: 'mijia-automation' }) } }] }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            } else {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这是最终回复正文' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });

    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-multistep-'));

    try {
        const store = new SessionStore(dir);
        const session = await store.createSession();
        const agent = new Agent({} as GatewayClient, {
            baseURL: `http://127.0.0.1:${port}/v1`,
            apiKey: 'k',
            model: 'm',
            temperature: 0,
        });
        (agent as any).sessionStore = store;
        await agent.loadSession(session.id);

        const outputs: any[] = [];
        for await (const out of agent.run('测试多步序列')) {
            outputs.push(out);
        }

        const streamedText = outputs.filter(o => o.type === 'text').map(o => o.content).join('');
        assert.ok(streamedText.includes('这是最终回复正文'));
        const completeOut = outputs.find(o => o.type === 'complete');
        assert.equal(completeOut?.message, '这是最终回复正文');
        assert.equal(completeOut?.usage?.stepCount, 3);

        const stored = await store.getMessages(session.id);
        const assistantStored = stored.find(m => m.role === 'assistant')!;
        assert.equal(assistantStored.thinking, '先查设备列表');
        assert.equal(assistantStored.content, '这是最终回复正文');

        const history = agent.getHistory();
        const toolMsgs = history.filter(m => m.role === 'tool') as any[];
        assert.equal(toolMsgs.length, 2, '两步串行工具调用应重放为两条独立 tool 消息而非压平');
        assert.equal(toolMsgs[0].content[0].result.omittedDuplicate, true, '早期重复激活的同一 Skill 应自动折叠掩码');
        assert.equal(Boolean(toolMsgs[1].content[0].result.content), true, '最近一次激活保留完整正文');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        server.close();
    }
});

test('Web 工具对齐：支持紧凑文本 create_graph、get_device 默认精简摘要且超长输出受 40KB 硬截断保护', async () => {
    const urn = 'urn:miot-spec-v2:device:light:0000A001:yeelink-lamp22:1';
    const hugePayload = 'x'.repeat(MAX_WEB_TOOL_RESULT_BYTES + 10_000);
    let savedGraph: any = null;

    const gateway = {
        async callApi(method: string, params: any): Promise<unknown> {
            if (method === 'getDevList') {
                return {
                    devList: {
                        d1: {
                            name: '走廊灯',
                            model: 'yeelink.light.lamp22',
                            modelName: '易来走廊灯',
                            urn,
                            online: true,
                            roomName: '走廊',
                        },
                    },
                };
            }
            if (method === 'getGraphList') return [];
            if (method === 'getVarScopeList') return { scopes: [] };
            if (method === 'getVarList') return {};
            if (method === 'setGraph') {
                savedGraph = params;
                return {};
            }
            if (method === 'getApiList') {
                return { big: hugePayload };
            }
            return {};
        },
    } as unknown as GatewayClient;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        type: urn,
        services: [{
            iid: 2,
            description: 'Light',
            properties: [{ iid: 1, description: 'Switch', format: 'bool', access: ['read', 'write', 'notify'] }],
        }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    try {
        const tools = createCoreTools(gateway) as any;

        // 1. get_device 默认精简摘要
        const devSummary = await tools.get_device.execute({ dids: ['d1'] });
        assert.equal(devSummary.success, true);
        assert.equal(devSummary.data[0].urn, urn);
        assert.equal(devSummary.data[0].properties[0].access, 'rwn');
        assert.equal('triggers' in devSummary.data[0], false, 'summary 模式不应重复返回冗余 triggers 字段');

        // 2. create_graph 支持紧凑文本 DSL
        const created = await tools.create_graph.execute({
            name: '走廊 - 启用触发 - 开启走廊灯',
            text: 'load1 onLoad -> out1\nout1 set 走廊灯 2/1 = true',
        });
        assert.equal(created.success, true);
        assert.equal(savedGraph?.nodes?.length, 2);

        // 3. 超长输出自动安全截断
        const capped = await tools.call_gateway_api.execute({ method: 'getApiList', params: {}, timeout: 3000 });
        assert.equal(capped.truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(capped), 'utf8') <= MAX_WEB_TOOL_RESULT_BYTES + 512);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
