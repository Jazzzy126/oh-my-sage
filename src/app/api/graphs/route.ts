/**
 * 规则 API 路由
 * 从网关获取米家自动化规则 (Graph)
 */

import {NextRequest, NextResponse} from 'next/server';
import {getGateway, isGatewayConnected} from '@/server/gateway/shared';
import {
    createGraph,
    deleteGraph,
    getDeviceList,
    getDevices,
    getGraph,
    getGraphText,
    scanGraphs,
    summarizeGraph,
    toggleGraph,
    updateGraph,
} from '@/core';
import type {GraphNode} from '@/core';
import {z} from 'zod';

export const runtime = 'nodejs';

const variableSchema = z.discriminatedUnion('type', [
    z.object({id: z.string().regex(/^[a-zA-Z0-9]+$/), type: z.literal('number'), value: z.number(), name: z.string().trim().min(1).optional()}),
    z.object({id: z.string().regex(/^[a-zA-Z0-9]+$/), type: z.literal('string'), value: z.string(), name: z.string().trim().min(1).optional()}),
]);
const createSchema = z.object({name: z.string().trim().min(1), nodes: z.array(z.any()), variables: z.array(variableSchema).optional(), enable: z.boolean().optional()});
const updateSchema = z.object({id: z.string().min(1), name: z.string().trim().min(1).optional(), nodes: z.array(z.any()).optional(), enable: z.boolean().optional()}).refine(value => value.name !== undefined || value.nodes !== undefined || value.enable !== undefined, '至少提供一个更新字段');

interface RuleNodeItem {
    id: string;
    type: string;
    title: string;
    detail: string;
}

const TRIGGER_TYPES = new Set(['deviceInput', 'alarmClock', 'varChange', 'onLoad', 'deviceInputSetVar']);
const ACTION_TYPES = new Set(['deviceOutput', 'varSetNumber', 'varSetString', 'deviceGetSetVar']);

const NODE_TYPE_LABELS: Record<string, string> = {
    deviceInput: '设备触发',
    deviceInputSetVar: '设备变化写入变量',
    alarmClock: '定时触发',
    varChange: '变量变化触发',
    onLoad: '规则加载时',
    condition: '条件分支',
    deviceGet: '读取设备状态',
    varGet: '判断变量',
    timeRange: '时间段限制',
    delay: '延时等待',
    statusLast: '状态持续',
    loop: '循环执行',
    logicAnd: '且逻辑（全部满足）',
    logicOr: '或逻辑（任一满足）',
    logicNot: '非逻辑（取反）',
    signalOr: '任一信号触发',
    onlyNTimes: '仅触发限定次数',
    counter: '计数器',
    register: '状态锁存器',
    modeSwitch: '模式切换',
    eventSequence: '事件顺序判断',
    deviceOutput: '控制设备',
    varSetNumber: '设置数值变量',
    varSetString: '设置文本变量',
    deviceGetSetVar: '读取设备写入变量',
};

function formatDuration(ms?: unknown): string {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 3600000 && n % 3600000 === 0) return `${n / 3600000} 小时`;
    if (n >= 60000 && n % 60000 === 0) return `${n / 60000} 分钟`;
    if (n >= 1000 && n % 1000 === 0) return `${n / 1000} 秒`;
    return `${n} 毫秒`;
}

function formatVarName(props: Record<string, unknown>): string {
    const scope = typeof props.scope === 'string' ? props.scope : '';
    const id = typeof props.id === 'string' ? props.id : '';
    if (!id) return '变量';
    if (!scope || scope === 'global') return `全局变量 ${id}`;
    return `规则变量 ${id}`;
}

function describeNode(node: GraphNode, deviceNames: Map<string, string>): RuleNodeItem {
    const props = (node.props || {}) as Record<string, unknown>;
    const cfg = (node.cfg || {}) as Record<string, unknown>;
    const did = typeof props.did === 'string' ? props.did : '';
    const devName = did ? (deviceNames.get(did) || did) : '';
    const label = NODE_TYPE_LABELS[node.type] || node.type;

    if (node.type === 'deviceInput' || node.type === 'deviceGet' || node.type === 'deviceInputSetVar') {
        const siid = props.siid;
        const piid = props.piid;
        const eiid = props.eiid;
        const target = eiid !== undefined ? `事件 ${siid}.${eiid}` : `属性 ${siid}/${piid}`;
        const op = typeof props.operator === 'string' ? ` ${props.operator}` : '';
        const val = props.v1 !== undefined ? ` ${JSON.stringify(props.v1)}` : '';
        return {
            id: node.id,
            type: node.type,
            title: devName || label,
            detail: `${label}：${target}${op}${val}`,
        };
    }

    if (node.type === 'deviceOutput') {
        const siid = props.siid;
        const piid = props.piid;
        const aiid = props.aiid;
        const detail = aiid !== undefined
            ? `执行动作 ${siid}.${aiid}${Array.isArray(props.ins) && props.ins.length > 0 ? ` (${JSON.stringify(props.ins)})` : ''}`
            : `设置属性 ${siid}/${piid}${props.value !== undefined ? ` = ${JSON.stringify(props.value)}` : ''}`;
        return {
            id: node.id,
            type: node.type,
            title: devName || label,
            detail,
        };
    }

    if (node.type === 'deviceGetSetVar') {
        return {
            id: node.id,
            type: node.type,
            title: devName || label,
            detail: `读取属性 ${props.siid}/${props.piid} 写入 ${formatVarName(props)}`,
        };
    }

    if (node.type === 'alarmClock') {
        const timeStr = typeof props.time === 'string'
            ? props.time
            : props.hour !== undefined
                ? `${String(props.hour).padStart(2, '0')}:${String(props.minute ?? 0).padStart(2, '0')}`
                : typeof cfg.time === 'string'
                    ? cfg.time
                    : '指定时刻';
        return {id: node.id, type: node.type, title: label, detail: `定时 ${timeStr}`};
    }

    if (node.type === 'timeRange') {
        const start = props.startTime ?? props.start ?? '';
        const end = props.endTime ?? props.end ?? '';
        return {
            id: node.id,
            type: node.type,
            title: label,
            detail: start || end ? `${start} - ${end}` : '在限定时间段内生效',
        };
    }

    if (node.type === 'delay' || node.type === 'statusLast' || node.type === 'loop') {
        const dur = formatDuration(props.timeout ?? props.interval);
        return {
            id: node.id,
            type: node.type,
            title: label,
            detail: dur || '按设定时长执行',
        };
    }

    if (node.type === 'varChange' || node.type === 'varGet') {
        const op = typeof props.operator === 'string' ? ` ${props.operator}` : '';
        const val = props.v1 !== undefined ? ` ${JSON.stringify(props.v1)}` : '';
        return {
            id: node.id,
            type: node.type,
            title: formatVarName(props),
            detail: `${label}${op}${val}`,
        };
    }

    if (node.type === 'varSetNumber' || node.type === 'varSetString') {
        return {
            id: node.id,
            type: node.type,
            title: formatVarName(props),
            detail: label,
        };
    }

    return {
        id: node.id,
        type: node.type,
        title: label,
        detail: `节点 #${node.id}`,
    };
}

/**
 * GET 请求处理
 * - 无 id 参数：返回规则摘要列表
 * - 带 id 参数：返回单条规则的结构化详情与紧凑文本
 */
export async function GET(request: NextRequest) {
    try {
        // 检查网关连接
        if (!isGatewayConnected()) {
            return NextResponse.json({
                success: false,
                error: '未连接到网关',
                message: '请先登录连接网关',
                graphs: [],
            }, {status: 400});
        }

        const gateway = getGateway()!;
        const {searchParams} = new URL(request.url);
        const graphId = searchParams.get('id');

        if (graphId) {
            const [graphRes, textRes, devicesRes] = await Promise.all([
                getGraph(gateway, graphId),
                getGraphText(gateway, graphId).catch(() => null),
                getDevices(gateway).catch(() => null),
            ]);

            if (!graphRes.success) {
                return NextResponse.json({
                    success: false,
                    error: graphRes.error || '获取规则详情失败',
                }, {status: 404});
            }
            if (!graphRes.data) {
                return NextResponse.json({
                    success: false,
                    error: '未找到规则数据',
                }, {status: 404});
            }

            const graph = graphRes.data;
            const summary = summarizeGraph(graph);
            const deviceNames = new Map<string, string>();
            if (devicesRes?.success && Array.isArray(devicesRes.data)) {
                for (const dev of devicesRes.data) {
                    deviceNames.set(dev.did, dev.name);
                }
            }

            const triggers: RuleNodeItem[] = [];
            const conditions: RuleNodeItem[] = [];
            const actions: RuleNodeItem[] = [];

            for (const node of graph.nodes || []) {
                if (node.type === 'nop') continue;
                const item = describeNode(node, deviceNames);
                if (TRIGGER_TYPES.has(node.type)) {
                    triggers.push(item);
                } else if (ACTION_TYPES.has(node.type)) {
                    actions.push(item);
                } else {
                    conditions.push(item);
                }
            }

            return NextResponse.json({
                success: true,
                graph: {
                    id: graph.id,
                    name: graph.cfg?.userData?.name || summary.name || '未命名规则',
                    enable: graph.cfg?.enable !== false,
                    lastUpdateTime: graph.cfg?.userData?.lastUpdateTime,
                    nodeCount: summary.nodeCount,
                    note: summary.note || '',
                    text: textRes?.success && textRes.data ? textRes.data.text : '',
                    triggers,
                    conditions,
                    actions,
                },
            });
        }

        // 通过增量缓存并发扫描规则节点与设备房间映射，组装每条规则的所属房间
        const [scannedGraphs, devList] = await Promise.all([
            scanGraphs(gateway),
            getDeviceList(gateway).catch(() => ({} as Record<string, { roomName?: string }>)),
        ]);

        const didRoomMap = new Map<string, string>();
        const knownRooms = new Set<string>();
        for (const [did, dev] of Object.entries(devList || {})) {
            const room = dev.roomName?.trim();
            if (room) {
                didRoomMap.set(did, room);
                knownRooms.add(room);
            }
        }
        const sortedKnownRooms = Array.from(knownRooms).sort((a, b) => b.length - a.length);

        const graphSummaries = scannedGraphs.map(({summary, nodes}) => {
            const name = summary.userData?.name || '未命名规则';
            const roomSet = new Set<string>();

            if (Array.isArray(nodes)) {
                for (const node of nodes) {
                    const did = (typeof node.cfg?.did === 'string' && node.cfg.did)
                        || (typeof node.props?.did === 'string' && node.props.did)
                        || '';
                    if (!did) continue;
                    const room = didRoomMap.get(did);
                    if (room) roomSet.add(room);
                }
            }

            // 若规则无设备节点（如纯定时/变量规则），按规则名称中的已知房间名辅助归类
            if (roomSet.size === 0) {
                for (const room of sortedKnownRooms) {
                    if (name.includes(room)) {
                        roomSet.add(room);
                        break;
                    }
                }
            }

            return {
                id: summary.id,
                name,
                enable: summary.enable !== false,
                lastUpdateTime: summary.userData?.lastUpdateTime,
                rooms: Array.from(roomSet),
            };
        });

        return NextResponse.json({
            success: true,
            count: graphSummaries.length,
            graphs: graphSummaries,
        });
    } catch (error) {
        console.error('获取规则列表错误:', error);

        return NextResponse.json({
            success: false,
            error: '获取规则列表失败',
            message: error instanceof Error ? error.message : '未知错误',
            graphs: [],
        }, {status: 500});
    }
}

export async function POST(request: NextRequest) {
    try {
        if (!isGatewayConnected()) return NextResponse.json({success: false, error: '未连接到网关'}, {status: 400});
        const parsed = createSchema.safeParse(await request.json());
        if (!parsed.success) return NextResponse.json({success: false, error: '规则参数无效', details: parsed.error.issues}, {status: 400});
        const {name, nodes, variables, enable = true} = parsed.data;
        const result = await createGraph(getGateway()!, {name, nodes, variables, enable});
        return NextResponse.json(result, {status: result.success ? 201 : 502});
    } catch (error) {
        return NextResponse.json({success: false, error: `创建规则失败: ${error}`}, {status: 500});
    }
}

export async function PUT(request: NextRequest) {
    try {
        if (!isGatewayConnected()) return NextResponse.json({success: false, error: '未连接到网关'}, {status: 400});
        const parsed = updateSchema.safeParse(await request.json());
        if (!parsed.success) return NextResponse.json({success: false, error: '规则参数无效', details: parsed.error.issues}, {status: 400});
        const {id, name, nodes, enable} = parsed.data;
        const result = await updateGraph(getGateway()!, id, {name, nodes, enable});
        return NextResponse.json(result, {status: result.success ? 200 : 502});
    } catch (error) {
        return NextResponse.json({success: false, error: `更新规则失败: ${error}`}, {status: 500});
    }
}

/**
 * PATCH 请求处理
 * 启用/禁用规则
 */
export async function PATCH(request: NextRequest) {
    try {
        // 检查网关连接
        if (!isGatewayConnected()) {
            return NextResponse.json({
                success: false,
                error: '未连接到网关',
            }, {status: 400});
        }

        const body = await request.json();
        const {id, enable} = body;

        if (!id) {
            return NextResponse.json({
                success: false,
                error: '缺少规则 ID',
            }, {status: 400});
        }

        if (typeof enable !== 'boolean') {
            return NextResponse.json({
                success: false,
                error: 'enable 参数必须为布尔值',
            }, {status: 400});
        }

        const result = await toggleGraph(getGateway()!, id, enable);
        return NextResponse.json(result, {status: result.success ? 200 : 404});
    } catch (error) {
        console.error('修改规则状态错误:', error);

        return NextResponse.json({
            success: false,
            error: '修改规则状态失败',
            message: error instanceof Error ? error.message : '未知错误',
        }, {status: 500});
    }
}

/**
 * DELETE 请求处理
 * 删除规则
 */
export async function DELETE(request: NextRequest) {
    try {
        // 检查网关连接
        if (!isGatewayConnected()) {
            return NextResponse.json({
                success: false,
                error: '未连接到网关',
            }, {status: 400});
        }

        const {searchParams} = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({
                success: false,
                error: '缺少规则 ID',
            }, {status: 400});
        }

        const gateway = getGateway()!;

        const result = await deleteGraph(gateway, id);
        if (!result.success) {
            return NextResponse.json(result, {status: 500});
        }

        return NextResponse.json({
            success: true,
            message: result.message || '规则已删除',
        });
    } catch (error) {
        console.error('删除规则错误:', error);

        return NextResponse.json({
            success: false,
            error: '删除规则失败',
            message: error instanceof Error ? error.message : '未知错误',
        }, {status: 500});
    }
}
