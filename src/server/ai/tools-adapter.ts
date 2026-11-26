/**
 * Web Agent - 工具适配器
 * 将 Core 工具函数适配为 Vercel AI SDK 格式，并与 MCP 端对齐精简输出、紧凑规则文本与安全截断保护
 */

import {z} from 'zod';
import {tool} from 'ai';
import {jsonSchema, type Schema, zodSchema} from '@ai-sdk/ui-utils';
import {
    GatewayClient,
    callGatewayApi,
    getDevices,
    getDevice,
    findDeviceUsage,
    getGraphs,
    getGraph,
    createGraph,
    updateGraph,
    deleteGraph,
    toggleGraph,
    getVariables,
    setVariable,
    createVariable,
    deleteVariable,
    getVariableValue,
    getVariableConfig,
    validateGraph,
    validateGraphCapabilitiesWithGateway,
    getGraphText,
    patchGraphV2,
    putGraphText,
    queryRules,
    getGraphLog,
    checkGraphLayout,
    graphHash,
    buildTextContext,
    textToNodes,
} from '@/core';
import type {DeviceInfo, MiotPropertyCapability, Graph, GraphNode} from '@/core';
import {getSkillByName, formatSkillContent, readSkillFile, getSkillCatalog} from '../skills/loader';

// ==================== 输出上限与精简摘要 ====================

/** 单个工具返回值的最大 UTF-8 字节数，防止超大响应撑爆模型上下文 */
export const MAX_WEB_TOOL_RESULT_BYTES = 40_000;
const MAX_ENUM_VALUES = 30;

function capUtf8Text(text: string, hint: string, maxBytes = MAX_WEB_TOOL_RESULT_BYTES): string {
    const total = Buffer.byteLength(text, 'utf8');
    if (total <= maxBytes) return text;
    const buildNote = (shown: number) => `\n[已截断：原始 ${total} 字节，仅保留前 ${shown} 字节。${hint}]`;
    const budget = Math.max(0, maxBytes - Buffer.byteLength(buildNote(maxBytes), 'utf8'));

    let bytes = 0;
    let cut = 0;
    for (const ch of text) {
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > budget) break;
        bytes += size;
        cut += ch.length;
    }
    const newline = text.lastIndexOf('\n', cut - 1);
    if (newline > 0 && newline >= cut / 2) cut = newline;
    const head = text.slice(0, cut);
    return `${head}${buildNote(Buffer.byteLength(head, 'utf8'))}`;
}

function capToolOutput<T>(result: T, hint = '请缩小查询范围或使用过滤条件重试'): T | Record<string, unknown> {
    if (result === null || result === undefined) return result;
    let serialized: string;
    try {
        serialized = JSON.stringify(result);
    } catch {
        return result;
    }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') <= MAX_WEB_TOOL_RESULT_BYTES) {
        return result;
    }
    const totalBytes = Buffer.byteLength(serialized, 'utf8');
    const obj = typeof result === 'object' ? (result as Record<string, unknown>) : {};
    return {
        success: obj.success !== false,
        truncated: true,
        totalBytes,
        hint,
        preview: capUtf8Text(serialized, hint, MAX_WEB_TOOL_RESULT_BYTES - 256),
    };
}

function summarizeMiotProperty(p: MiotPropertyCapability) {
    const accessList = p.access || [];
    const access = `${accessList.includes('read') ? 'r' : ''}${accessList.includes('write') ? 'w' : ''}${accessList.includes('notify') ? 'n' : ''}`;
    const item: Record<string, unknown> = {
        siid: p.siid,
        piid: p.piid,
        desc: p.desc,
        dtype: p.dtype,
        access,
    };
    if (p.unit) item.unit = p.unit;
    if (p.range) item.range = p.range;
    if (p.list && p.list.length > 0) {
        item.values = p.list.slice(0, MAX_ENUM_VALUES).map(v => ({v: v.value, d: v.description}));
        if (p.list.length > MAX_ENUM_VALUES) {
            item.valuesTruncated = p.list.length - MAX_ENUM_VALUES;
        }
    }
    return item;
}

function summarizeWebDevice(device: DeviceInfo, siids?: number[]) {
    if (device.found === false) return {did: device.did, found: false};
    const keep = (siid: number) => !siids || siids.length === 0 || siids.includes(siid);
    const summary: Record<string, unknown> = {
        did: device.did,
        found: true,
        name: device.name,
        model: device.model,
        modelName: device.modelName,
        online: device.online,
        roomName: device.roomName,
        urn: device.urn,
        properties: (device.properties || []).filter(p => keep(p.siid)).map(summarizeMiotProperty),
        events: (device.events || [])
            .filter(e => keep(e.siid))
            .map(e => ({siid: e.siid, eiid: e.eiid, desc: e.desc, args: (e.arguments || []).map(a => a.piid)})),
        actions: (device.actions || [])
            .filter(a => a.type === 'action' && typeof a.aiid === 'number' && keep(a.siid))
            .map(a => ({siid: a.siid, aiid: a.aiid, desc: a.desc, in: (a.in || []).map(p => p.piid)})),
    };
    if (device.specError) summary.specError = device.specError;
    return summary;
}

function normalizeTypedValue(
    type: 'number' | 'string',
    value: number | string
): { ok: true; value: number | string } | { ok: false; error: string } {
    if (type === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) return {ok: true, value};
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed)) return {ok: true, value: parsed};
        }
        return {ok: false, error: 'value 必须与 type (number) 匹配'};
    }
    if (typeof value === 'string') return {ok: true, value};
    return {ok: false, error: 'value 必须与 type (string) 匹配'};
}

function withDefaultCfg(graph: { id: string; nodes: unknown[]; cfg?: unknown }): Graph {
    const cfg = (graph.cfg && typeof graph.cfg === 'object' && 'userData' in (graph.cfg as object)
        ? graph.cfg
        : {
            id: graph.id,
            enable: true,
            uiType: 'graph',
            userData: {name: graph.id, lastUpdateTime: 0, transform: {x: 0, y: 0, scale: 1, rotate: 0}},
        }) as Graph['cfg'];
    return {id: graph.id, nodes: (graph.nodes || []) as GraphNode[], cfg};
}

// ==================== 规则修改参数 ====================

const positionsSchema = z.record(z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
}));

const layoutOptionsSchema = z.object({
    mode: z.enum(['incremental', 'full']).optional().describe('incremental（默认）只摆放没有坐标的卡片；full 全图重排'),
    pinned: z.array(z.string()).optional().describe('full 模式下保持不动的节点'),
});

const mergeSchema = z.object({
    id: z.string().min(1).describe('要局部修改的节点 ID'),
    props: z.record(z.unknown()).optional().describe('浅合并到 props；值为 null 删除该键'),
    cfg: z.record(z.unknown()).optional().describe('浅合并到 cfg；值为 null 删除该键'),
    outputs: z.record(z.array(z.string())).optional().describe('按端口整体替换 outputs'),
    inputs: z.record(z.unknown()).optional().describe('浅合并到 inputs；值为 null 删除该键'),
});

const noteOperationSchema = z.object({
    section: z.string().optional(),
    append: z.string().optional(),
    replace: z.string().optional(),
    with: z.string().optional(),
    changelog: z.string().optional(),
    set: z.string().optional(),
});

const patchVariableSchema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9]+$/),
    scope: z.string().default('rule'),
    type: z.enum(['number', 'string']),
    value: z.union([z.number(), z.string()]),
    name: z.string().optional(),
});

const ruleVariableSchema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9]+$/),
    type: z.enum(['number', 'string']),
    value: z.union([z.number(), z.string()]),
    name: z.string().trim().min(1).optional(),
});

function patchArrayItems(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(patchArrayItems);
    }

    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    const patched = Object.fromEntries(
        Object.entries(schema).map(([key, value]) => [key, patchArrayItems(value)])
    ) as Record<string, unknown>;

    if (patched.type === 'array' && !('items' in patched)) {
        patched.items = {};
    }

    return patched;
}

function compatibleParameters<OBJECT>(
    schema: z.Schema<OBJECT, z.ZodTypeDef, any>
): Schema<OBJECT> {
    const baseSchema = zodSchema(schema);

    return jsonSchema<OBJECT>(patchArrayItems(baseSchema.jsonSchema) as any, {
        validate: value => {
            const result = schema.safeParse(value);
            return result.success
                ? {success: true, value: result.data}
                : {success: false, error: result.error};
        },
    });
}

function defineTool<P extends z.Schema<any, z.ZodTypeDef, any>, RESULT>(config: {
    description?: string;
    parameters: P;
    hint?: string;
    execute?: (args: z.infer<P>, options: {abortSignal?: AbortSignal}) => PromiseLike<RESULT>;
}) {
    const {hint, execute, ...rest} = config;
    return tool({
        ...rest,
        parameters: compatibleParameters(config.parameters),
        execute: execute
            ? async (args: z.infer<P>, opts: {abortSignal?: AbortSignal}) => {
                const raw = await execute(args, opts);
                return capToolOutput(raw, hint);
            }
            : undefined,
    } as any);
}

// ==================== 规则写入确认守卫 ====================

export type MutationKind = 'create' | 'modify' | 'delete';

export interface CoreToolsOptions {
    /**
     * 判断当前轮次是否已获用户确认、允许执行指定类别的写操作。
     * 未提供时默认允许（兼容直接单测工具的场景）。
     */
    canMutateGraph?: (kind?: MutationKind) => boolean;
    /**
     * 调用 ask_user 时触发，用于立即收回本轮规则写权限，防止同一步并行偷跑。
     */
    onAskUser?: () => void;
}

function guardGraphMutation(
    options: CoreToolsOptions | undefined,
    actionLabel: string,
    kind: MutationKind
): { success: false; blocked: true; requiresConfirmation: true; error: string } | null {
    if (!options?.canMutateGraph || options.canMutateGraph(kind)) {
        return null;
    }
    return {
        success: false,
        blocked: true,
        requiresConfirmation: true,
        error: `尚未获得用户针对「${actionLabel}」的明确确认，已拦截该操作。请先向用户清晰说明拟执行的方案（触发条件、判断逻辑、执行动作或删除对象），并调用 ask_user 提供确认选项，待用户回复确认后再执行。`,
    };
}

export function createCoreTools(gateway: GatewayClient, options?: CoreToolsOptions) {
    return {
        think: defineTool({
            description: '仅用于复杂任务的逻辑梳理（如多状态机规则设计）。简单任务（查询设备、查看规则等）不要使用此工具，直接调用相应工具即可。',
            parameters: z.object({
                thought: z.string().describe('思考内容'),
                nextAction: z.string().optional().describe('下一步行动'),
            }),
            execute: async ({thought, nextAction}) => {
                return {
                    success: true,
                    thought,
                    nextAction,
                };
            },
        }),

        ask_user: defineTool({
            description: '向用户展示方案并等待选择或确认。创建、修改、删除自动化规则或删除变量前必须先调用此工具获得用户确认；简单查询任务不要使用。',
            parameters: z.object({
                question: z.string().describe('问题或方案说明内容'),
                options: z.array(z.string()).min(1).describe('供用户选择的选项列表，至少包含 1 个选项'),
                needConfirm: z.boolean().optional().describe('是否需要确认'),
            }),
            execute: async ({question, options: userOptions, needConfirm}) => {
                options?.onAskUser?.();
                const normalizedOptions = Array.isArray(userOptions) && userOptions.length > 0
                    ? userOptions
                    : ['确认执行', '取消'];
                return {
                    success: true,
                    needsUserInput: true,
                    question,
                    options: normalizedOptions,
                    needConfirm,
                };
            },
        }),

        get_devices: defineTool({
            description: '获取设备列表（预览模式，只返回关键字段 did、name、modelName、online、roomName）。若用户消息中已附带设备 DID，可直接调 get_device 无需先调本工具。',
            parameters: z.object({}),
            hint: '设备较多时可改用 find_device_usage 按关键词过滤',
            execute: async () => {
                return getDevices(gateway);
            },
        }),

        get_device: defineTool({
            description: '获取设备详情及 MIOT Spec 能力（含完整 urn，构造节点必须原样使用）。默认 detail="summary" 返回去重精简摘要；可通过 siids 仅过滤指定服务。',
            parameters: z.object({
                dids: z.array(z.string()).min(1).describe('设备ID数组'),
                detail: z.enum(['summary', 'full']).optional().describe('summary=去重精简能力（默认），full=完整原始对象'),
                siids: z.array(z.number().int()).optional().describe('可选：只返回这些 siid 服务的属性/事件/动作'),
            }),
            hint: '请使用 siids 限定服务或减少单次查询的 dids 数量',
            execute: async ({dids, detail = 'summary', siids}) => {
                const res = await getDevice(gateway, dids);
                if (!res.success || detail === 'full') {
                    return res;
                }
                const raw = res.data ?? [];
                const notFound = raw.filter(d => d.found === false).map(d => d.did);
                return {
                    success: true,
                    count: raw.length,
                    ...(notFound.length > 0 ? {notFound} : {}),
                    data: raw.map(d => summarizeWebDevice(d, siids)),
                };
            },
        }),

        find_device_usage: defineTool({
            description: '扫描全部自动化规则，找出哪些规则和节点引用了指定设备（触发/读取/控制），并检测已移除设备的残留孤儿引用。替代逐条 get_graph 翻查。',
            parameters: z.object({
                dids: z.array(z.string()).optional().describe('设备 ID 数组'),
                query: z.string().optional().describe('按名称/型号/房间/DID 模糊匹配'),
            }),
            hint: '请用更精确的 dids 或 query 缩小范围',
            execute: async ({dids, query}) => {
                return findDeviceUsage(gateway, {dids, query});
            },
        }),

        call_gateway_api: defineTool({
            description: '仅在用户明确要求排障、发现网关接口或查询未被专用工具覆盖的只读数据时使用。只能调用已验证的只读 API；写入、删除和未知方法会被拒绝。',
            parameters: z.object({
                method: z.string().describe('已验证的只读网关 API 方法名，例如 getApiList、getLog、getVarScopeList'),
                params: z.record(z.unknown()).default({}).describe('API 参数对象'),
                timeout: z.number().int().min(1000).max(10000).default(10000).describe('超时时间（毫秒）'),
            }),
            execute: async ({method, params, timeout}) => {
                return callGatewayApi(gateway, method, params, timeout);
            },
        }),

        get_graphs: defineTool({
            description: '获取所有自动化规则列表',
            parameters: z.object({}),
            execute: async () => {
                return getGraphs(gateway);
            },
        }),

        get_graph: defineTool({
            description: '获取指定规则。默认 format="text" 返回紧凑文本（一行一个节点 + Markdown 备注 + hash + layoutHash，省上下文且可直接用于 patch_graph）；大规则可用 focus 只看相关节点及上下游；需要原始 JSON 时传 format="json"。',
            parameters: z.object({
                id: z.string().describe('规则ID'),
                format: z.enum(['json', 'text']).optional().describe('text=紧凑文本（默认推荐），json=完整规则对象'),
                focus: z.array(z.string()).optional().describe('只看这些节点及其上下游（自动使用文本格式）'),
                depth: z.number().int().min(0).max(5).optional().describe('focus 的上下游步数，默认 1'),
                ifNoneMatch: z.string().optional().describe('已知 hash；规则未变化时只返回 unchanged'),
            }),
            hint: '大规则请使用 focus 指定核心节点只读取局部子图',
            execute: async ({id, format = 'text', focus, depth = 1, ifNoneMatch}) => {
                const wantText = format === 'text' || (focus !== undefined && focus.length > 0);
                if (ifNoneMatch) {
                    const current = await getGraph(gateway, id);
                    if (!current.success) return current;
                    const hash = graphHash(current.data!.nodes || []);
                    if (hash === ifNoneMatch) return {success: true, data: {id, unchanged: true, hash}};
                    if (!wantText) return current;
                }
                if (wantText) return getGraphText(gateway, id, {focus, depth});
                return getGraph(gateway, id);
            },
        }),

        patch_graph: defineTool({
            description: `【需用户确认】修改已有规则的首选方式（非 dryRun 写入前必须先经 ask_user 获得用户确认；dryRun:true 预览可直接调用）：一次调用完成建变量、改节点、改备注、结构与能力校验和写入。先用 get_graph({id, format:"text"}) 拿到 hash。
- add: 新增节点（紧凑文本，可多行，可含 var 声明和 @tts/@pulse 宏）；ID 已存在时拒绝
- replace: 整行替换已有节点（紧凑文本）；ID 不存在时拒绝
- merge: 只改个别字段或连线（outputs 按端口整体替换）；removeIds: 删除节点并清理连线
- note: 备注操作 {section, append} / {replace, with} / {changelog} / {set}
- variables: 需要的变量，不存在才创建；scope 写 "rule" 表示本规则
- positions: {节点ID: {x, y}} 只挪卡片；layout: 默认只给新卡片找空位，{mode:"full"} 全图重排
- baseHash 必传；挪卡片或重排时同时传 baseLayoutHash；dryRun:true 只预览`,
            parameters: z.object({
                id: z.string().describe('规则ID'),
                baseHash: z.string().optional().describe('get_graph 返回的 hash，规则已被他人修改时拒绝写入'),
                baseLayoutHash: z.string().optional().describe('get_graph 返回的 layoutHash，卡片被别人挪动过时拒绝写入'),
                add: z.string().optional().describe('新增节点的紧凑文本'),
                replace: z.string().optional().describe('替换已有节点的紧凑文本'),
                merge: z.array(mergeSchema).optional().describe('局部合并的节点字段'),
                removeIds: z.array(z.string()).optional().describe('要删除的节点 ID'),
                note: z.array(noteOperationSchema).optional().describe('备注操作'),
                noteId: z.string().optional().describe('要修改的备注节点 ID，缺省为第一个备注'),
                variables: z.array(patchVariableSchema).optional().describe('需要的变量；不存在时创建'),
                positions: positionsSchema.optional().describe('只改卡片位置'),
                layout: layoutOptionsSchema.optional().describe('布局方式，默认只摆放新卡片'),
                verifyLayout: z.boolean().optional().describe('写入后回读确认坐标已保存（多一次网关往返，默认不做）'),
                dryRun: z.boolean().optional().describe('只预览，不写入'),
                name: z.string().min(1).optional().describe('新规则名称'),
                enable: z.boolean().optional().describe('是否启用'),
            }),
            execute: async ({id, name, enable, variables, ...patch}) => {
                if (!patch.dryRun) {
                    const blocked = guardGraphMutation(options, '修改规则', 'modify');
                    if (blocked) return blocked;
                }
                const normalizedVariables: Array<{id: string; scope: string; type: 'number' | 'string'; value: number | string; name?: string}> = [];
                for (const variable of variables || []) {
                    const coerced = normalizeTypedValue(variable.type, variable.value);
                    if (!coerced.ok) return {success: false, error: `变量 ${variable.id} 的初始值类型必须是 ${variable.type}`};
                    normalizedVariables.push({...variable, value: coerced.value});
                }
                const hasNodeChange = Boolean(patch.add || patch.replace || patch.merge?.length || patch.removeIds?.length || patch.note?.length
                    || normalizedVariables.length || (patch.positions && Object.keys(patch.positions).length) || patch.layout?.mode === 'full');
                if (!hasNodeChange) {
                    if (name === undefined && enable === undefined) return {success: true, data: {graphId: id, message: '无变化'}};
                    return updateGraph(gateway, id, {name, enable});
                }
                const result = await patchGraphV2(gateway, id, {
                    ...patch,
                    variables: normalizedVariables.length > 0 ? normalizedVariables : undefined,
                });
                if (!result.success || patch.dryRun || (name === undefined && enable === undefined)) return result;
                const meta = await updateGraph(gateway, id, {name, enable});
                return meta.success ? result : meta;
            },
        }),

        put_graph_text: defineTool({
            description: '【需用户确认】用一份完整的紧凑文本（get_graph format="text" 的格式）替换规则内容（非 dryRun 写入前必须先经 ask_user 获得用户确认）。必须传 baseHash。',
            parameters: z.object({
                id: z.string().describe('规则ID'),
                baseHash: z.string().describe('读取文本时的 hash'),
                baseLayoutHash: z.string().optional().describe('读取文本时的 layoutHash'),
                text: z.string().describe('完整紧凑文本'),
                layout: layoutOptionsSchema.optional().describe('布局方式，默认只摆放新卡片'),
                dryRun: z.boolean().optional().describe('只预览，不写入'),
            }),
            execute: async ({id, ...input}) => {
                if (!input.dryRun) {
                    const blocked = guardGraphMutation(options, '替换规则文本', 'modify');
                    if (blocked) return blocked;
                }
                return putGraphText(gateway, id, input);
            },
        }),

        query_rules: defineTool({
            description: '在服务端扫描全部规则，只返回命中的节点（紧凑文本）。用于找「谁在读某变量」「谁在控制某设备属性」，不要逐条读规则。条件可组合（同时满足）。',
            parameters: z.object({
                variable: z.string().optional().describe('"$livingOccupied"（全局）、"$R1234.x"（指定作用域）或 "x"（任意作用域）'),
                device: z.string().optional().describe('did 或设备名称'),
                property: z.string().optional().describe('"siid/piid"'),
                nodeType: z.string().optional().describe('节点类型，如 varChange'),
                contains: z.string().optional().describe('节点文本包含的字符串'),
                graphs: z.array(z.string()).optional().describe('只查这些规则'),
            }),
            hint: '命中过多，请增加过滤条件或限定 graphs',
            execute: async (query) => queryRules(gateway, query),
        }),

        get_log: defineTool({
            description: '读取网关执行日志并在服务端过滤。只记录规则执行（连线触发和节点取值），不记录设备自身上报。排查规则为什么没执行时，先用 summary:true 看各节点执行次数，找出执行链断在哪一步。时间为 UTC+8。',
            parameters: z.object({
                graph: z.string().optional().describe('规则ID'),
                nodes: z.array(z.string()).optional().describe('只看这些节点'),
                minutes: z.number().positive().max(10080).optional().describe('最近多少分钟，默认 60'),
                limit: z.number().int().positive().max(2000).optional().describe('最多返回多少行（取最新），默认 200'),
                summary: z.boolean().optional().describe('只返回各节点执行次数'),
            }),
            hint: '请缩短 minutes、减少 limit 或指定 graph/nodes',
            execute: async (query) => getGraphLog(gateway, query),
        }),

        check_layout: defineTool({
            description: '只读检查规则的卡片布局（重叠、可能重叠、穿卡连线、交叉估计、分区），不写入网关。可带 positions 或 layout 预览修改效果。',
            parameters: z.object({
                id: z.string().describe('规则ID'),
                positions: positionsSchema.optional().describe('预览这些位置修改'),
                layout: layoutOptionsSchema.optional().describe("预览布局方式，如 {mode:'full'}"),
                limit: z.number().int().min(1).max(200).optional().describe('每类问题最多列出几条，默认 30'),
            }),
            execute: async ({id, ...input}) => checkGraphLayout(gateway, id, input),
        }),

        create_graph: defineTool({
            description: '【需用户确认】创建新的自动化规则（内置结构校验、MIOT 能力校验与自动布局）。调用前必须先向用户展示方案并通过 ask_user 获得确认。支持并优先推荐传紧凑文本 text（一行一个节点，支持 var $R.名 声明本规则变量与 @tts/@pulse 宏），也兼容传 nodes 数组（二选一）。',
            parameters: z.object({
                name: z.string().min(1).describe('规则名称'),
                text: z.string().optional().describe('推荐：紧凑规则文本（与 nodes 二选一）；语法见 mijia-automation Skill'),
                nodes: z.array(z.any()).optional().describe('节点 JSON 数组（与 text 二选一）'),
                variables: z.array(ruleVariableSchema).optional().describe('本规则变量定义；节点引用时 scope 使用 rule'),
                enable: z.boolean().optional().describe('是否启用，默认 true'),
            }),
            execute: async ({name, text, nodes, variables, enable = true}) => {
                const blocked = guardGraphMutation(options, '创建规则', 'create');
                if (blocked) return blocked;

                if ((nodes === undefined) === (text === undefined)) {
                    return {success: false, error: 'nodes 与 text 必须且只能提供一个'};
                }

                const normalizedVars: Array<{id: string; type: 'number'; value: number; name?: string} | {id: string; type: 'string'; value: string; name?: string}> = [];
                for (const v of variables || []) {
                    const coerced = normalizeTypedValue(v.type, v.value);
                    if (!coerced.ok) return {success: false, error: `变量 ${v.id}: ${coerced.error}`};
                    if (v.type === 'number') {
                        normalizedVars.push({id: v.id, type: 'number', value: coerced.value as number, ...(v.name ? {name: v.name} : {})});
                    } else {
                        normalizedVars.push({id: v.id, type: 'string', value: coerced.value as string, ...(v.name ? {name: v.name} : {})});
                    }
                }

                let createNodes = nodes as GraphNode[] | undefined;
                if (text !== undefined) {
                    try {
                        const ctx = await buildTextContext(gateway, 'rule', [], text);
                        ctx.scope = 'rule';
                        const parsed = textToNodes(text, ctx);
                        const foreign = parsed.variables.filter(v => v.scope !== 'rule');
                        if (foreign.length > 0) {
                            return {
                                success: false,
                                error: `新建规则的 var 只能声明本规则变量（$R.名），全局变量请先用 create_variable 创建：${foreign.map(v => `${v.scope}/${v.id}`).join(', ')}`,
                            };
                        }
                        createNodes = parsed.nodes;
                        for (const pv of parsed.variables) {
                            if (pv.type === 'number') {
                                normalizedVars.push({id: pv.id, type: 'number', value: pv.value as number, ...(pv.name ? {name: pv.name} : {})});
                            } else {
                                normalizedVars.push({id: pv.id, type: 'string', value: pv.value as string, ...(pv.name ? {name: pv.name} : {})});
                            }
                        }
                    } catch (err) {
                        return {success: false, error: `解析紧凑规则文本失败: ${err instanceof Error ? err.message : String(err)}`};
                    }
                }

                return createGraph(gateway, {
                    name,
                    nodes: createNodes!,
                    variables: normalizedVars.length > 0 ? normalizedVars : undefined,
                    enable,
                });
            },
        }),

        update_graph: defineTool({
            description: '【需用户确认】整图替换现有规则（需要传全部节点）。调用前必须先经 ask_user 获得用户确认。修改已有规则优先用 patch_graph，只在补丁无法表达时使用。',
            parameters: z.object({
                id: z.string().describe('规则ID'),
                name: z.string().optional().describe('新规则名称'),
                nodes: z.array(z.any()).optional().describe('新节点列表'),
                enable: z.boolean().optional().describe('是否启用'),
            }),
            execute: async ({id, name, nodes, enable}) => {
                const blocked = guardGraphMutation(options, '更新规则', 'modify');
                if (blocked) return blocked;
                return updateGraph(gateway, id, {name, nodes, enable});
            },
        }),

        delete_graph: defineTool({
            description: '【需用户确认】删除指定的自动化规则。调用前必须先向用户说明待删除规则并通过 ask_user 获得删除确认。',
            parameters: z.object({
                id: z.string().describe('规则ID'),
            }),
            execute: async ({id}) => {
                const blocked = guardGraphMutation(options, '删除规则', 'delete');
                if (blocked) return blocked;
                return deleteGraph(gateway, id);
            },
        }),

        toggle_graph: defineTool({
            description: '启用或禁用指定的自动化规则',
            parameters: z.object({
                id: z.string().describe('规则ID'),
                enable: z.boolean().describe('是否启用'),
            }),
            execute: async ({id, enable}) => {
                return toggleGraph(gateway, id, enable);
            },
        }),

        get_variables: defineTool({
            description: '获取变量列表',
            parameters: z.object({
                scope: z.string().optional().describe('变量作用域，默认 global'),
            }),
            execute: async ({scope = 'global'}) => {
                return getVariables(gateway, scope);
            },
        }),

        set_variable: defineTool({
            description: '设置变量的值',
            parameters: z.object({
                id: z.string().describe('变量ID'),
                value: z.union([z.string(), z.number()]).describe('变量值'),
                scope: z.string().optional().describe('变量作用域，默认 global'),
            }),
            execute: async ({id, value, scope = 'global'}) => {
                return setVariable(gateway, id, value, scope);
            },
        }),

        create_variable: defineTool({
            description: '创建自动化变量（id 必须为纯字母数字）',
            parameters: z.object({
                id: z.string().regex(/^[a-zA-Z0-9]+$/),
                type: z.enum(['number', 'string']),
                value: z.union([z.number(), z.string()]),
                name: z.string().trim().min(1).optional(),
                scope: z.string().optional(),
            }),
            execute: async ({id, type, value, name, scope = 'global'}) => {
                const coerced = normalizeTypedValue(type, value);
                if (!coerced.ok) return {success: false, error: 'value 必须与 type 匹配'};
                return createVariable(gateway, id, type, coerced.value, name, scope);
            },
        }),

        delete_variable: defineTool({
            description: '【需用户确认】删除自动化变量；仍被规则引用时拒绝删除',
            parameters: z.object({
                id: z.string().describe('变量 ID'),
                scope: z.string().optional().describe('变量作用域，默认 global'),
            }),
            execute: async ({id, scope = 'global'}) => {
                const blocked = guardGraphMutation(options, '删除变量', 'delete');
                if (blocked) return blocked;
                return deleteVariable(gateway, id, scope);
            },
        }),

        get_variable_value: defineTool({
            description: '获取变量当前值',
            parameters: z.object({id: z.string(), scope: z.string().optional()}),
            execute: async ({id, scope = 'global'}) => getVariableValue(gateway, id, scope),
        }),

        get_variable_config: defineTool({
            description: '获取变量配置',
            parameters: z.object({id: z.string(), scope: z.string().optional()}),
            execute: async ({id, scope = 'global'}) => getVariableConfig(gateway, id, scope),
        }),

        validate_graph: defineTool({
            description: '校验规则连接完整性。可传已保存规则 id（服务端读取），或传待校验的 nodes（cfg 可省略）',
            parameters: z.object({
                id: z.string().optional().describe('已保存规则 ID（与 nodes 二选一）'),
                nodes: z.array(z.any()).optional().describe('节点列表'),
                cfg: z.any().optional().describe('规则配置，可省略'),
            }),
            execute: async ({id, nodes, cfg}) => {
                let target: Graph;
                if (nodes) {
                    const graphId = (cfg && typeof cfg.id === 'string' ? cfg.id : id) || 'draft';
                    target = withDefaultCfg({id: graphId, nodes, cfg});
                } else if (id) {
                    const loaded = await getGraph(gateway, id);
                    if (!loaded.success) {
                        return {success: false, valid: false, error: loaded.error};
                    }
                    if (!loaded.data) {
                        return {success: false, valid: false, error: '无法读取规则'};
                    }
                    target = loaded.data;
                } else {
                    return {success: false, valid: false, error: '必须提供 id 或 nodes'};
                }

                const errors = validateGraph(target as any);

                if (errors.length === 0) {
                    return {success: true, valid: true, message: '规则校验通过'};
                }

                const errorList = errors
                    .filter(e => e.level === 'error')
                    .map(e => ({node: e.nodeId, type: e.type, message: e.message}));
                const warnList = errors
                    .filter(e => e.level === 'warn')
                    .map(e => ({node: e.nodeId, type: e.type, message: e.message}));

                return {
                    success: true,
                    valid: errorList.length === 0,
                    errors: errorList,
                    warnings: warnList,
                    message: errorList.length > 0
                        ? `发现 ${errorList.length} 个错误，必须修复后才能创建规则`
                        : `校验通过（${warnList.length} 个警告）`,
                };
            },
        }),

        validate_graph_capabilities: defineTool({
            description: '根据真实 MIOT Spec 校验规则中的设备能力和变量引用。支持传已保存规则 id 或待校验 graph 对象，可选传 variables 预检本规则变量（scope="rule"）',
            parameters: z.object({
                id: z.string().optional().describe('已保存规则 ID（与 graph 二选一）'),
                graph: z.object({id: z.string(), nodes: z.array(z.any()), cfg: z.any().optional()}).optional().describe('待校验规则对象'),
                variables: z.array(ruleVariableSchema).optional().describe('本规则变量声明，用于创建前校验 scope=rule 的引用'),
            }),
            execute: async ({id, graph, variables}) => {
                let target: Graph;
                if (graph) {
                    target = withDefaultCfg(graph);
                } else if (id) {
                    const loaded = await getGraph(gateway, id);
                    if (!loaded.success) {
                        return {success: false, valid: false, error: loaded.error};
                    }
                    if (!loaded.data) {
                        return {success: false, valid: false, error: '无法读取规则'};
                    }
                    target = loaded.data;
                } else {
                    return {success: false, valid: false, error: '必须提供 id 或 graph 之一'};
                }
                const ruleVariables = variables?.map(v => ({id: v.id, type: v.type}));
                return validateGraphCapabilitiesWithGateway(
                    gateway,
                    target as any,
                    ruleVariables ? {ruleVariables} : undefined
                );
            },
        }),

        activate_skill: defineTool({
            description: '激活指定的 Skill，加载规则语法、设计模式和节点模板',
            parameters: z.object({
                name: z.string().describe('Skill 名称'),
            }),
            execute: async ({name}) => {
                const skill = getSkillByName(name);
                if (!skill) {
                    const catalog = getSkillCatalog({domainFilter: 'smart-home'});
                    const available = catalog.map(s => s.name).join(', ');
                    return {
                        success: false,
                        error: `Skill "${name}" 不存在。可用的 Skills: ${available}`,
                    };
                }

                return {
                    success: true,
                    skill: skill.name,
                    content: formatSkillContent(skill),
                    resources: skill.resources,
                    message: `已激活 Skill: ${skill.name}`,
                };
            },
        }),

        read_skill_file: defineTool({
            description: '读取 Skill 目录中的参考资源文件',
            parameters: z.object({
                skillName: z.string().describe('Skill 名称'),
                filePath: z.string().describe('相对于 Skill 目录的文件路径'),
            }),
            execute: async ({skillName, filePath}) => {
                const content = readSkillFile(skillName, filePath);
                if (content === null) {
                    return {
                        success: false,
                        error: `无法读取文件: ${filePath}`,
                    };
                }

                return {
                    success: true,
                    skillName,
                    filePath,
                    content,
                };
            },
        }),
    };
}
