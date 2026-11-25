import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CoreMessage } from 'ai';
import { Agent, hasAskUserInLastAssistantTurn } from '../../src/server/agent/agent';
import { createCoreTools } from '../../src/server/ai/tools-adapter';
import { SessionStore } from '../../src/server/session/store';
import type { GatewayClient } from '../../src/core/gateway/client';

type MockStep =
    | { toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
    | { content: string };

function startScriptedMock(steps: MockStep[]): Promise<{ port: number; close: () => void; getStepIndex: () => number }> {
    let idx = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const current = steps[idx++] ?? { content: '结束' };
            if ('toolCalls' in current) {
                current.toolCalls.forEach((tc, i) => {
                    res.write(
                        `data: ${JSON.stringify({
                            choices: [{
                                index: 0,
                                delta: {
                                    tool_calls: [{
                                        index: i,
                                        id: tc.id,
                                        type: 'function',
                                        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                                    }],
                                },
                                finish_reason: null,
                            }],
                        })}\n\n`
                    );
                });
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            } else {
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: current.content }, finish_reason: 'stop' }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise(resolve =>
        server.listen(0, '127.0.0.1', () =>
            resolve({
                port: (server.address() as any).port,
                close: () => server.close(),
                getStepIndex: () => idx,
            }),
        ),
    );
}

test('hasAskUserInLastAssistantTurn 正确识别上一轮是否发起过确认', () => {
    assert.equal(hasAskUserInLastAssistantTurn([]), false);

    const plainReply: CoreMessage[] = [
        { role: 'user', content: '看设备' },
        { role: 'assistant', content: '这是设备列表' },
    ];
    assert.equal(hasAskUserInLastAssistantTurn(plainReply), false);

    const askedUser: CoreMessage[] = [
        { role: 'user', content: '建个规则' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ask_user', args: { question: '确认吗', options: ['确认'] } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'ask_user', result: { success: true, needsUserInput: true } }] },
    ];
    assert.equal(hasAskUserInLastAssistantTurn(askedUser), true);

    const afterConfirmedAndCompleted: CoreMessage[] = [
        ...askedUser,
        { role: 'user', content: '确认' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'create_graph', args: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'create_graph', result: { success: true } }] },
        { role: 'assistant', content: '已创建' },
    ];
    assert.equal(hasAskUserInLastAssistantTurn(afterConfirmedAndCompleted), false);
});

test('createCoreTools 守卫：未确认时拦截写操作，放行 dryRun 和 toggle_graph', async () => {
    let allow = false;
    let gatewayCalled: string[] = [];
    const gateway = {
        async callApi(method: string): Promise<unknown> {
            gatewayCalled.push(method);
            if (method === 'getGraphList') {
                return [{ id: '1700000000001', name: '测试', enable: true, lastUpdateTime: 0 }];
            }
            if (method === 'getGraph') {
                return {
                    id: '1700000000001',
                    nodes: [],
                    cfg: { id: '1700000000001', enable: true, uiType: 'graph', userData: { name: '测试', lastUpdateTime: 0, transform: { x: 0, y: 0, scale: 1, rotate: 0 } } },
                };
            }
            if (method === 'setGraph' || method === 'delGraph') return {};
            return {};
        },
    } as unknown as GatewayClient;

    const tools = createCoreTools(gateway, {
        canMutateGraph: () => allow,
        onAskUser: () => {
            allow = false;
        },
    }) as any;

    const createRes = await tools.create_graph.execute({ name: '规则1', nodes: [] });
    assert.equal(createRes.success, false);
    assert.equal(createRes.blocked, true);

    const patchRes = await tools.patch_graph.execute({ id: '1700000000001', name: '新名' });
    assert.equal(patchRes.success, false);
    assert.equal(patchRes.blocked, true);

    const putRes = await tools.put_graph_text.execute({ id: '1700000000001', baseHash: 'h', text: '' });
    assert.equal(putRes.success, false);
    assert.equal(putRes.blocked, true);

    const updateRes = await tools.update_graph.execute({ id: '1700000000001', name: '新名' });
    assert.equal(updateRes.success, false);
    assert.equal(updateRes.blocked, true);

    const deleteRes = await tools.delete_graph.execute({ id: '1700000000001' });
    assert.equal(deleteRes.success, false);
    assert.equal(deleteRes.blocked, true);

    assert.deepEqual(gatewayCalled, [], '被拦截的写操作不应调用网关 API');

    // dryRun 预览不受拦截
    const dryRunRes = await tools.patch_graph.execute({ id: '1700000000001', dryRun: true, removeIds: ['n1'] });
    assert.notEqual(dryRunRes.blocked, true);

    // toggle_graph（启用/禁用）不受拦截
    const toggleRes = await tools.toggle_graph.execute({ id: '1700000000001', enable: false });
    assert.equal(toggleRes.success, true);

    // ask_user 调用后会立即收回 allow，并兜底空选项
    allow = true;
    const askRes = await tools.ask_user.execute({ question: '确认吗', options: [] });
    assert.equal(allow, false);
    assert.equal(askRes.needsUserInput, true);
    assert.deepEqual(askRes.options, ['确认执行', '取消']);
});

test('Agent 端到端：未确认前拦截 create_graph，经 ask_user 确认后放行，下一轮重新上锁', async () => {
    const validNodes = [
        {
            id: 'load1',
            type: 'onLoad',
            cfg: { name: 'onLoad', version: 1 },
            props: {},
            inputs: {},
            outputs: { output: ['delay1.input'] },
        },
        {
            id: 'delay1',
            type: 'delay',
            cfg: { name: 'delay', version: 1, unit: 's', value: 5 },
            props: { timeout: 5000 },
            inputs: { input: null },
            outputs: { output: [] },
        },
    ];

    const mock = await startScriptedMock([
        // 第 1 轮 step 1：模型试图直接创建规则（将被拦截）
        { toolCalls: [{ id: 'c1', name: 'create_graph', args: { name: '偷跑规则', nodes: validNodes } }] },
        // 第 1 轮 step 2：被拦截后模型调用 ask_user
        { toolCalls: [{ id: 'c2', name: 'ask_user', args: { question: '确认创建「测试规则」吗？', options: ['确认创建', '取消'] } }] },
        // 第 2 轮 step 1：用户确认后，模型调用 create_graph（应放行）
        { toolCalls: [{ id: 'c3', name: 'create_graph', args: { name: '测试规则', nodes: validNodes } }] },
        // 第 2 轮 step 2：完成回复
        { content: '规则已创建' },
        // 第 3 轮 step 1：新需求下模型试图直接删除规则（应再次被拦截）
        { toolCalls: [{ id: 'c4', name: 'delete_graph', args: { id: '1700000000001' } }] },
        // 第 3 轮 step 2：改用 ask_user 确认
        { toolCalls: [{ id: 'c5', name: 'ask_user', args: { question: '确认删除该规则吗？', options: ['确认删除', '取消'] } }] },
    ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-sage-confirm-'));
    try {
        const writeApiCalls: string[] = [];
        const gateway = {
            async callApi(method: string): Promise<unknown> {
                if (method === 'setGraph' || method === 'delGraph') {
                    writeApiCalls.push(method);
                }
                if (method === 'getDevList') return { devList: {} };
                if (method === 'getGraphList') return [];
                return {};
            },
        } as unknown as GatewayClient;

        const store = new SessionStore(dir);
        const session = await store.createSession();
        const modelConfig = {
            baseURL: `http://127.0.0.1:${mock.port}/v1`,
            apiKey: 'k',
            model: 'm',
            temperature: 0,
        } as any;

        const makeAgent = async () => {
            const agent = new Agent(gateway, modelConfig);
            (agent as any).sessionStore = store;
            await agent.loadSession(session.id);
            return agent;
        };

        // 第 1 轮：直接创建应被拦截，最终以 waiting_input 暂停
        const agent1 = await makeAgent();
        const outputs1: any[] = [];
        for await (const out of agent1.run('帮我创建一个规则')) {
            outputs1.push(out);
        }
        assert.deepEqual(writeApiCalls, [], '第 1 轮未确认前不得调用 setGraph');
        assert.equal(outputs1.some(o => o.type === 'tool_result' && o.tool === 'create_graph' && o.result?.blocked === true), true);
        assert.equal(outputs1.at(-1)?.type, 'waiting_input');

        // 第 2 轮（模拟新 HTTP 请求新建 Agent）：用户确认后应放行 setGraph
        const agent2 = await makeAgent();
        const outputs2: any[] = [];
        for await (const out of agent2.run('确认创建')) {
            outputs2.push(out);
        }
        assert.deepEqual(writeApiCalls, ['setGraph'], '用户确认后应成功调用 setGraph');
        assert.equal(outputs2.at(-1)?.type, 'complete');

        // 第 3 轮：新请求应重新上锁，直接 delete_graph 再次被拦截
        const agent3 = await makeAgent();
        const outputs3: any[] = [];
        for await (const out of agent3.run('把那个规则删了')) {
            outputs3.push(out);
        }
        assert.deepEqual(writeApiCalls, ['setGraph'], '第 3 轮未重新确认前不得调用 delGraph');
        assert.equal(outputs3.some(o => o.type === 'tool_result' && o.tool === 'delete_graph' && o.result?.blocked === true), true);
        assert.equal(outputs3.at(-1)?.type, 'waiting_input');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        mock.close();
    }
});

test('Agent 端到端：同一步并行调用 ask_user 和 create_graph 时，create_graph 仍被拦截', async () => {
    const mock = await startScriptedMock([
        {
            toolCalls: [
                { id: 'p1', name: 'ask_user', args: { question: '确认创建吗？', options: ['确认', '取消'] } },
                { id: 'p2', name: 'create_graph', args: { name: '并行偷跑', nodes: [] } },
            ],
        },
    ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-sage-parallel-confirm-'));
    try {
        let setGraphCalled = false;
        const gateway = {
            async callApi(method: string): Promise<unknown> {
                if (method === 'setGraph') setGraphCalled = true;
                return {};
            },
        } as unknown as GatewayClient;

        const store = new SessionStore(dir);
        const session = await store.createSession();
        const agent = new Agent(gateway, {
            baseURL: `http://127.0.0.1:${mock.port}/v1`,
            apiKey: 'k',
            model: 'm',
            temperature: 0,
        } as any);
        (agent as any).sessionStore = store;
        agent.setSession(session.id);

        const outputs: any[] = [];
        for await (const out of agent.run('帮我建个规则')) {
            outputs.push(out);
        }

        assert.equal(setGraphCalled, false, '同一步并行调用 create_graph 不应写入网关');
        assert.equal(outputs.some(o => o.type === 'tool_result' && o.tool === 'create_graph' && o.result?.blocked === true), true);
        assert.equal(outputs.at(-1)?.type, 'waiting_input');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        mock.close();
    }
});
