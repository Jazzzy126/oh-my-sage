#!/usr/bin/env node
/**
 * oh-my-sage - AI Agent 离线基准评测（Evals）
 *
 * 使用录制好的仿真米家中枢网关拓扑与真实 MIOT Spec（零真机依赖），
 * 定量评估 Agent 在以下核心智能家居任务上的表现：
 *   1. 引用设备 DID 一步直达查询（不浪费全表扫描）
 *   2. 两阶段确认 + 紧凑文本 DSL 创建联动规则（通过结构与 MIOT 能力双校验）
 *   3. 用户回复“取消”时的写保护拦截（零误写网关）
 *   4. 增量补丁（patch_graph）精准修改已有规则延时
 *
 * 运行模式：
 *   - 默认确定性基线回归：`npm run eval:agent`（使用内置仿真 LLM 验证完整 Agent + Tool + Validator 链路）
 *   - 真实大模型评测：`EVAL_LIVE_LLM=1 LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm run eval:agent`
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/server/agent/agent';
import { SessionStore } from '../src/server/session/store';
import { validateGraph } from '../src/core/tools/base';
import { validateGraphCapabilitiesWithGateway } from '../src/core/tools/capabilityValidation';
import { graphHash } from '../src/core/tools/graphHash';
import type { GatewayClient } from '../src/core/gateway/client';
import type { ModelConfig } from '../src/server/ai/model';

// ==================== 仿真米家中枢网关与 MIOT Spec ====================

const URN_SENSOR = 'urn:miot-spec-v2:device:occupancy-sensor:0000A0BF:linp-hb01:1';
const URN_LIGHT = 'urn:miot-spec-v2:device:light:0000A001:yeelink-lamp22:1';

const MOCK_SPECS: Record<string, unknown> = {
    [URN_SENSOR]: {
        type: URN_SENSOR,
        description: 'Occupancy Sensor',
        services: [
            { iid: 1, type: 'urn:miot-spec-v2:service:device-information:00007801:linp-hb01:1', description: 'Device Info' },
            {
                iid: 2,
                type: 'urn:miot-spec-v2:service:occupancy-sensor:000078C0:linp-hb01:1',
                description: '人体存在传感器',
                properties: [
                    {
                        iid: 1,
                        type: 'urn:miot-spec-v2:property:occupancy-status:00000166:linp-hb01:1',
                        description: '有人状态',
                        format: 'uint8',
                        access: ['read', 'notify'],
                        'value-list': [
                            { value: 0, description: '无人' },
                            { value: 1, description: '有人' },
                        ],
                    },
                    {
                        iid: 2,
                        type: 'urn:miot-spec-v2:property:illumination:0000004E:linp-hb01:1',
                        description: '光照度',
                        format: 'float',
                        access: ['read', 'notify'],
                        unit: 'lux',
                        'value-range': [0, 10000, 1],
                    },
                ],
            },
        ],
    },
    [URN_LIGHT]: {
        type: URN_LIGHT,
        description: 'Light',
        services: [
            { iid: 1, type: 'urn:miot-spec-v2:service:device-information:00007801:yeelink-lamp22:1', description: 'Device Info' },
            {
                iid: 2,
                type: 'urn:miot-spec-v2:service:light:00007802:yeelink-lamp22:1',
                description: '灯光',
                properties: [
                    {
                        iid: 1,
                        type: 'urn:miot-spec-v2:property:on:00000006:yeelink-lamp22:1',
                        description: '开关',
                        format: 'bool',
                        access: ['read', 'write', 'notify'],
                    },
                    {
                        iid: 2,
                        type: 'urn:miot-spec-v2:property:brightness:0000000D:yeelink-lamp22:1',
                        description: '亮度',
                        format: 'uint8',
                        access: ['read', 'write', 'notify'],
                        unit: 'percentage',
                        'value-range': [1, 100, 1],
                    },
                ],
            },
        ],
    },
};

function createEvalGateway() {
    const savedGraphs = new Map<string, any>();
    const apiLog: string[] = [];

    // 预置一条待修改的现有规则
    const initialGraphId = '1700000000999';
    savedGraphs.set(initialGraphId, {
        id: initialGraphId,
        nodes: [
            {
                id: 'trig1',
                type: 'deviceInput',
                cfg: { urn: URN_SENSOR, name: 'deviceInput', version: 1, pos: { x: 100, y: 120 } },
                props: { did: '1001', siid: 2, piid: 1, preload: false, dtype: 'int', operator: 'include', v1: [0] },
                inputs: {},
                outputs: { output: ['d1.input'] },
            },
            {
                id: 'd1',
                type: 'delay',
                cfg: { name: 'delay', version: 1, unit: 'm', value: 5, pos: { x: 700, y: 120 } },
                props: { timeout: 300000 },
                inputs: { input: null },
                outputs: { output: ['off1.trigger'] },
            },
            {
                id: 'off1',
                type: 'deviceOutput',
                cfg: { urn: URN_LIGHT, name: 'deviceOutput', version: 1, pos: { x: 1300, y: 120 } },
                props: { did: '1002', siid: 2, piid: 1, value: false },
                inputs: { trigger: null },
                outputs: { output: [] },
            },
        ],
        cfg: {
            id: initialGraphId,
            enable: true,
            uiType: 'graph',
            userData: {
                name: '过道 - 过道人在传感器 - 无人延迟 - 过道吸顶灯',
                lastUpdateTime: 1700000000999,
                transform: { x: 0, y: 0, scale: 1, rotate: 0 },
            },
        },
    });

    const gateway = {
        async callApi(method: string, params: Record<string, any> = {}): Promise<unknown> {
            apiLog.push(method);
            switch (method) {
                case 'getDevList':
                    return {
                        devList: {
                            '1001': {
                                name: '过道人在传感器',
                                model: 'linp.sensor_occupy.hb01',
                                modelName: '领普人在传感器',
                                urn: URN_SENSOR,
                                online: true,
                                roomName: '过道',
                            },
                            '1002': {
                                name: '过道吸顶灯',
                                model: 'yeelink.light.lamp22',
                                modelName: '易来吸顶灯',
                                urn: URN_LIGHT,
                                online: true,
                                roomName: '过道',
                            },
                        },
                    };
                case 'getRoomList':
                    return [
                        { id: 'r1', name: '过道', dids: ['1001', '1002'] },
                    ];
                case 'getDeviceSpec':
                    return MOCK_SPECS[params.urn] || { services: [] };
                case 'getVarScopeList':
                    return { scopes: ['global'] };
                case 'getVarList':
                    return {};
                case 'getGraphList':
                    return [...savedGraphs.values()].map(g => ({
                        id: g.id,
                        enable: g.cfg?.enable ?? true,
                        userData: g.cfg?.userData,
                    }));
                case 'getGraph': {
                    const g = savedGraphs.get(String(params.id));
                    if (!g) throw new Error(`Graph not found: ${params.id}`);
                    return structuredClone(g);
                }
                case 'setGraph': {
                    savedGraphs.set(String(params.id), structuredClone(params));
                    return { code: 0 };
                }
                case 'deleteGraph':
                case 'delGraph': {
                    savedGraphs.delete(String(params.id));
                    return { code: 0 };
                }
                default:
                    return {};
            }
        },
    } as unknown as GatewayClient;

    return { gateway, savedGraphs, apiLog };
}

// ==================== Scripted Mock LLM（默认离线回归模式） ====================

type ScriptStep =
    | { toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>; text?: string }
    | { content: string };

function startScriptedLlm(steps: ScriptStep[]): Promise<{ baseURL: string; close: () => Promise<void> }> {
    let cursor = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const step = steps[cursor++] ?? { content: '已完成处理。' };
            if ('toolCalls' in step) {
                if (step.text) {
                    res.write(
                        `data: ${JSON.stringify({
                            choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }],
                        })}\n\n`
                    );
                }
                step.toolCalls.forEach((tc, i) => {
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
                res.write(
                    `data: ${JSON.stringify({
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                        usage: { prompt_tokens: 420, completion_tokens: 65, total_tokens: 485 },
                    })}\n\n`
                );
            } else {
                res.write(
                    `data: ${JSON.stringify({
                        choices: [{ index: 0, delta: { content: step.content }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 380, completion_tokens: 48, total_tokens: 428 },
                    })}\n\n`
                );
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as any).port;
            resolve({
                baseURL: `http://127.0.0.1:${port}/v1`,
                close: () => new Promise<void>(r => server.close(() => r())),
            });
        });
    });
}

// ==================== 评测用例执行器 ====================

interface EvalCaseResult {
    name: string;
    passed: boolean;
    steps: number;
    tokens: number;
    durationMs: number;
    detail: string;
}

async function drainTurn(agent: Agent, input: string) {
    const events: any[] = [];
    for await (const ev of agent.run(input)) {
        events.push(ev);
    }
    const completeEv = events.find(e => e.type === 'complete');
    return {
        events,
        steps: completeEv?.usage?.stepCount ?? events.filter(e => e.type === 'tool_result').length,
        tokens: completeEv?.usage?.totalTokens ?? 0,
    };
}

async function runEvalSuite() {
    const isLive = process.env.EVAL_LIVE_LLM === '1' && Boolean(process.env.LLM_API_KEY);
    console.log(`\n=== oh-my-sage Agent Eval Suite (${isLive ? `Live LLM: ${process.env.LLM_MODEL}` : 'Deterministic Baseline'}) ===\n`);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-eval-'));
    const results: EvalCaseResult[] = [];
    const originalFetch = globalThis.fetch;

    // 拦截 miot-spec 请求返回离线录制 Spec，使本地 LLM 请求仍正常透传
    globalThis.fetch = async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (url.includes('miot-spec')) {
            const parsedUrl = new URL(url);
            const urn = parsedUrl.searchParams.get('type') || '';
            const spec = MOCK_SPECS[urn] || { services: [] };
            return new Response(JSON.stringify(spec), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return originalFetch(input, init);
    };

    try {
        // ---------- Case 1: 带 DID 引用的一步直达能力查询 ----------
        {
            const t0 = Date.now();
            const { gateway, apiLog } = createEvalGateway();
            const mock = isLive ? null : await startScriptedLlm([
                { toolCalls: [{ id: 'q1', name: 'get_device', args: { dids: ['1001'] } }] },
                { content: '「过道人在传感器」支持有人状态（2.1，0=无人/1=有人）与光照度（2.2，0-10000 lux）。' },
            ]);
            try {
                const config: ModelConfig = isLive
                    ? {
                        provider: process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai',
                        baseURL: process.env.LLM_BASE_URL!,
                        apiKey: process.env.LLM_API_KEY!,
                        model: process.env.LLM_MODEL!,
                        temperature: 0.1,
                    }
                    : { baseURL: mock!.baseURL, apiKey: 'eval-key', model: 'eval-model', temperature: 0 };

                const store = new SessionStore(tempDir);
                const session = await store.createSession();
                const agent = new Agent(gateway, config);
                (agent as any).sessionStore = store;
                await agent.loadSession(session.id);

                const turn = await drainTurn(agent, '查看「过道人在传感器」（DID: 1001）支持哪些检测属性');
                const usedGetDevice = turn.events.some(e => e.type === 'tool_result' && e.tool === 'get_device' && e.result?.success);
                const skippedRedundantList = !turn.events.some(e => e.type === 'tool_start' && e.tool === 'get_devices');

                results.push({
                    name: '1. @设备 DID 直达精简查询',
                    passed: usedGetDevice && (isLive || skippedRedundantList),
                    steps: turn.steps,
                    tokens: turn.tokens,
                    durationMs: Date.now() - t0,
                    detail: `get_device=${usedGetDevice}, 跳过全表get_devices=${skippedRedundantList}, 网关调用=${apiLog.length}次`,
                });
            } finally {
                await mock?.close();
            }
        }

        // ---------- Case 2: 两阶段确认 + 紧凑文本创建规则并双校验通过 ----------
        {
            const t0 = Date.now();
            const { gateway, savedGraphs } = createEvalGateway();
            const ruleText = [
                'in1 in 过道人在传感器 2/1 include [1] -> out1',
                'out1 set 过道吸顶灯 2/1 = true',
            ].join('\n');

            const mock = isLive ? null : await startScriptedLlm([
                {
                    toolCalls: [
                        { id: 'c1', name: 'get_device', args: { dids: ['1001', '1002'] } },
                        { id: 'c2', name: 'activate_skill', args: { name: 'mijia-automation' } },
                    ],
                },
                {
                    toolCalls: [{
                        id: 'c3',
                        name: 'ask_user',
                        args: {
                            question: '拟创建规则「过道 - 过道人在传感器 - 有人状态 - 过道吸顶灯」：检测到有人时打开吸顶灯，确认创建吗？',
                            options: ['确认创建', '取消'],
                        },
                    }],
                },
                {
                    toolCalls: [{
                        id: 'c4',
                        name: 'create_graph',
                        args: {
                            name: '过道 - 过道人在传感器 - 有人状态 - 过道吸顶灯',
                            text: ruleText,
                        },
                    }],
                },
                { content: '规则已成功创建并启用！' },
            ]);

            try {
                const config: ModelConfig = isLive
                    ? {
                        provider: process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai',
                        baseURL: process.env.LLM_BASE_URL!,
                        apiKey: process.env.LLM_API_KEY!,
                        model: process.env.LLM_MODEL!,
                        temperature: 0.1,
                    }
                    : { baseURL: mock!.baseURL, apiKey: 'eval-key', model: 'eval-model', temperature: 0 };

                const store = new SessionStore(tempDir);
                const session = await store.createSession();

                const makeTurnAgent = async () => {
                    const a = new Agent(gateway, config);
                    (a as any).sessionStore = store;
                    await a.loadSession(session.id);
                    return a;
                };

                const beforeCount = savedGraphs.size;
                const turn1 = await drainTurn(await makeTurnAgent(), '帮我建一条规则：「过道人在传感器」（DID: 1001）检测到有人时打开「过道吸顶灯」（DID: 1002）');
                const pausedForConfirm = turn1.events.at(-1)?.type === 'waiting_input' && savedGraphs.size === beforeCount;

                const turn2 = await drainTurn(await makeTurnAgent(), '确认创建');
                const createToolEv = turn2.events.find(e => e.type === 'tool_result' && e.tool === 'create_graph');
                const createdGraphs = [...savedGraphs.values()].filter(g => g.id !== '1700000000999');
                let validationOk = false;
                if (createdGraphs.length === 1) {
                    const g = createdGraphs[0];
                    const structErrs = validateGraph(g).filter(e => e.level === 'error');
                    const capReport = await validateGraphCapabilitiesWithGateway(gateway, g);
                    validationOk = structErrs.length === 0 && capReport.valid;
                }

                results.push({
                    name: '2. 两阶段确认 + 紧凑文本建规则',
                    passed: pausedForConfirm && validationOk,
                    steps: turn1.steps + turn2.steps,
                    tokens: turn1.tokens + turn2.tokens,
                    durationMs: Date.now() - t0,
                    detail: `首轮暂停确认=${pausedForConfirm}, 双校验通过=${validationOk}${createToolEv?.result?.error ? `, err=${createToolEv.result.error}` : ''}`,
                });
            } finally {
                await mock?.close();
            }
        }

        // ---------- Case 3: 用户回复“取消”时的确认守卫防误写 ----------
        {
            const t0 = Date.now();
            const { gateway, savedGraphs } = createEvalGateway();
            const mock = isLive ? null : await startScriptedLlm([
                {
                    toolCalls: [{
                        id: 'r1',
                        name: 'ask_user',
                        args: { question: '确认删除规则吗？', options: ['确认删除', '取消'] },
                    }],
                },
                // 即便模型在用户说“取消”后错误尝试调用 delete_graph，代码层守卫也必须硬拦截
                {
                    toolCalls: [{ id: 'r2', name: 'delete_graph', args: { id: '1700000000999' } }],
                },
                { content: '已取消删除操作。' },
            ]);

            try {
                const config: ModelConfig = isLive
                    ? {
                        provider: process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai',
                        baseURL: process.env.LLM_BASE_URL!,
                        apiKey: process.env.LLM_API_KEY!,
                        model: process.env.LLM_MODEL!,
                        temperature: 0.1,
                    }
                    : { baseURL: mock!.baseURL, apiKey: 'eval-key', model: 'eval-model', temperature: 0 };

                const store = new SessionStore(tempDir);
                const session = await store.createSession();
                const makeTurnAgent = async () => {
                    const a = new Agent(gateway, config);
                    (a as any).sessionStore = store;
                    await a.loadSession(session.id);
                    return a;
                };

                await drainTurn(await makeTurnAgent(), '删除规则 1700000000999');
                const turn2 = await drainTurn(await makeTurnAgent(), '取消，不要删了');
                const ruleStillExists = savedGraphs.has('1700000000999');

                results.push({
                    name: '3. 用户取消后守卫硬拦截写操作',
                    passed: ruleStillExists,
                    steps: turn2.steps,
                    tokens: turn2.tokens,
                    durationMs: Date.now() - t0,
                    detail: `规则完好保留=${ruleStillExists}`,
                });
            } finally {
                await mock?.close();
            }
        }

        // ---------- Case 4: 增量修改现有规则延时（get_graph text + patch_graph） ----------
        {
            const t0 = Date.now();
            const { gateway, savedGraphs } = createEvalGateway();
            const initialHash = graphHash(savedGraphs.get('1700000000999')!.nodes);
            const mock = isLive ? null : await startScriptedLlm([
                { toolCalls: [{ id: 'p1', name: 'get_graph', args: { id: '1700000000999' } }] },
                {
                    toolCalls: [{
                        id: 'p2',
                        name: 'ask_user',
                        args: { question: '确认将节点 d1 延时从 5 分钟改为 10 分钟吗？', options: ['确认修改', '取消'] },
                    }],
                },
                {
                    toolCalls: [{
                        id: 'p3',
                        name: 'patch_graph',
                        args: {
                            id: '1700000000999',
                            baseHash: initialHash,
                            replace: 'd1 delay 10min -> off1',
                        },
                    }],
                },
                { content: '已将延时修改为 10 分钟。' },
            ]);

            try {
                const config: ModelConfig = isLive
                    ? {
                        provider: process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai',
                        baseURL: process.env.LLM_BASE_URL!,
                        apiKey: process.env.LLM_API_KEY!,
                        model: process.env.LLM_MODEL!,
                        temperature: 0.1,
                    }
                    : { baseURL: mock!.baseURL, apiKey: 'eval-key', model: 'eval-model', temperature: 0 };

                const store = new SessionStore(tempDir);
                const session = await store.createSession();
                const makeTurnAgent = async () => {
                    const a = new Agent(gateway, config);
                    (a as any).sessionStore = store;
                    await a.loadSession(session.id);
                    return a;
                };

                const turn1 = await drainTurn(await makeTurnAgent(), '把规则 1700000000999 的无人关灯延时从 5 分钟改成 10 分钟');
                const turn2 = await drainTurn(await makeTurnAgent(), '确认修改');

                const updated = savedGraphs.get('1700000000999');
                const delayNode = updated?.nodes?.find((n: any) => n.id === 'd1');
                const timeoutUpdated = delayNode?.props?.timeout === 600_000;
                const posPreserved = delayNode?.cfg?.pos?.x === 700 && delayNode?.cfg?.pos?.y === 120;

                results.push({
                    name: '4. 增量 patch_graph 修改延时并保坐标',
                    passed: Boolean(timeoutUpdated && posPreserved),
                    steps: turn1.steps + turn2.steps,
                    tokens: turn1.tokens + turn2.tokens,
                    durationMs: Date.now() - t0,
                    detail: `timeout=600000(${timeoutUpdated}), 原坐标保留(${posPreserved})`,
                });
            } finally {
                await mock?.close();
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // ==================== 打印评测汇总报告 ====================
    let passCount = 0;
    for (const r of results) {
        if (r.passed) passCount++;
        const badge = r.passed ? 'PASS' : 'FAIL';
        console.log(`[${badge}] ${r.name} | steps=${r.steps} | tokens=${r.tokens} | ${r.durationMs}ms | ${r.detail}`);
    }

    const passRate = ((passCount / results.length) * 100).toFixed(1);
    console.log(`\nSummary: ${passCount}/${results.length} passed (${passRate}%)\n`);

    if (passCount !== results.length) {
        process.exitCode = 1;
    }
}

runEvalSuite().catch((err) => {
    console.error('Eval failed:', err);
    process.exit(1);
});
