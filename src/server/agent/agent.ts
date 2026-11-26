/**
 * oh-my-sage - Agent 核心
 * 实现工具驱动的多步 ReAct Agent 循环、实时流式分发、上下文压缩与写入确认守卫
 */

import {streamText, generateText, CoreMessage} from 'ai';
import {createModel, ModelConfig, getModelConfigFromEnv} from '../ai/model';
import {createCoreTools, type MutationKind} from '../ai/tools-adapter';
import {buildSystemPrompt} from '../ai/prompts';
import {GatewayClient} from '@/core';
import {getSessionStore, ToolCall, SessionStep, TurnUsage} from '../session/store';
import {formatSkillCatalogForPrompt} from '../skills/loader';

/**
 * Agent 输出事件类型
 */
export type AgentOutput =
    | { type: 'text'; content: string }
    | { type: 'thinking'; content: string }
    | { type: 'tool_start'; toolCallId?: string; tool: string; args: any }
    | { type: 'tool_result'; toolCallId?: string; tool: string; result: any }
    | { type: 'waiting_input'; question?: string; options?: string[] }
    | { type: 'complete'; message?: string; usage?: TurnUsage }
    | { type: 'error'; error: string };

export interface AgentRunOptions {
    /** 外部取消信号（如客户端断开 SSE 连接或点击停止） */
    abortSignal?: AbortSignal;
}

const USER_REJECTION_RE = /^(?:取消|不确认|算了|不用了?|不要了?|放弃|停止|暂不|先不|不改了|不删了|不建了)|^(?:no|cancel|abort|stop)(?:$|[\s,.!?，。！？])/i;
const DELETE_INTENT_RE = /删除|移除|清理|删掉|delete|remove/i;

/**
 * 判断用户输入是否为明确的拒绝/取消指令
 */
export function isUserRejectionInput(userInput?: string): boolean {
    if (!userInput) return true;
    const trimmed = userInput.trim();
    if (!trimmed) return true;
    return USER_REJECTION_RE.test(trimmed);
}

/**
 * 提取紧邻当前用户消息之前的上一轮助手回复中的 ask_user 调用参数（如存在）
 */
export function findAskUserInLastAssistantTurn(
    messages: CoreMessage[]
): { question?: string; options?: string[] } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user') {
            return null;
        }
        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'tool-call' && part.toolName === 'ask_user') {
                    const args = (part.args || {}) as { question?: string; options?: string[] };
                    return {
                        question: typeof args.question === 'string' ? args.question : undefined,
                        options: Array.isArray(args.options) ? args.options : undefined,
                    };
                }
                if (part.type === 'tool-result' && part.toolName === 'ask_user') {
                    const res = (part.result || {}) as { question?: string; options?: string[] };
                    return {
                        question: typeof res.question === 'string' ? res.question : undefined,
                        options: Array.isArray(res.options) ? res.options : undefined,
                    };
                }
            }
        }
    }
    return null;
}

/**
 * 判断紧邻当前用户消息之前的上一轮助手回复中，是否调用过 ask_user 向用户发起确认。
 */
export function hasAskUserInLastAssistantTurn(messages: CoreMessage[]): boolean {
    return findAskUserInLastAssistantTurn(messages) !== null;
}

/**
 * 根据上一轮 ask_user 内容与本轮用户回复，解析本轮允许放行的写操作类别：
 * - 用户回复明确取消/拒绝 → 空集合（全部拦截）
 * - 上一轮 ask_user 未提及删除类操作 → 仅放行 create / modify，拦截 delete（防跨意图误删）
 * - 上一轮 ask_user 提及删除类操作 → 放行 delete（及常规变更）
 */
export function resolveAllowedMutations(
    askInfo: { question?: string; options?: string[] } | null,
    userInput?: string
): Set<MutationKind> {
    const allowed = new Set<MutationKind>();
    if (!askInfo || isUserRejectionInput(userInput)) {
        return allowed;
    }

    const combinedText = [askInfo.question || '', ...(askInfo.options || [])].join(' ');
    if (DELETE_INTENT_RE.test(combinedText)) {
        allowed.add('delete');
        allowed.add('modify');
    } else {
        allowed.add('create');
        allowed.add('modify');
    }
    return allowed;
}

/**
 * 为历史压缩提取工具调用的关键事实摘要，避免压缩后丢失 DID、规则 ID 与校验结果
 */
export function summarizeToolCallsForCompression(toolCalls?: ToolCall[]): string {
    if (!toolCalls || toolCalls.length === 0) return '';
    const items: string[] = [];

    for (const tc of toolCalls) {
        if (tc.tool === 'think' || tc.tool === 'activate_skill' || tc.tool === 'read_skill_file') {
            continue;
        }
        const argsBrief: string[] = [];
        if (tc.args && typeof tc.args === 'object') {
            if (tc.args.id) argsBrief.push(`id=${tc.args.id}`);
            if (tc.args.name) argsBrief.push(`name=${tc.args.name}`);
            if (Array.isArray(tc.args.dids)) argsBrief.push(`dids=[${tc.args.dids.join(',')}]`);
            if (tc.args.device) argsBrief.push(`device=${tc.args.device}`);
            if (tc.args.variable) argsBrief.push(`var=${tc.args.variable}`);
        }

        const res = tc.result;
        let resBrief = tc.success ? '成功' : '失败';
        if (res && typeof res === 'object') {
            if (res.data?.graphId) resBrief += `(graphId=${res.data.graphId})`;
            else if (res.graphId) resBrief += `(graphId=${res.graphId})`;
            else if (Array.isArray(res.data) && tc.tool === 'get_devices') {
                const preview = res.data.slice(0, 8).map((d: any) => `${d.name}:${d.did}`).join(', ');
                if (preview) resBrief += `(${preview}${res.data.length > 8 ? '...' : ''})`;
            } else if (typeof res.error === 'string') {
                resBrief += `(${res.error.slice(0, 80)})`;
            }
        }
        items.push(`${tc.tool}(${argsBrief.join(', ')})->${resBrief}`);
    }

    return items.join('；');
}

/**
 * Agent 类
 * 实现持续运行的思考-行动循环
 */
export class Agent {
    /** 默认上下文压缩阈值（token 估算值）：64k 兼顾主流模型窗口上限、注意力质量与延迟成本 */
    private static readonly DEFAULT_MAX_CONTEXT_TOKENS = 64000;
    /** 压缩时保留的最近消息轮数（这些消息不参与压缩，直接保留） */
    private static readonly KEEP_RECENT_TURNS = 3;

    private messages: CoreMessage[] = [];
    private gateway: GatewayClient;
    private modelConfig: ModelConfig;
    private tools: any;
    private sessionId: string | null = null;
    private sessionStore = getSessionStore();
    private systemPrompt: string;
    private maxContextTokens: number;
    /** 当前轮次允许执行的写操作类别集合 */
    private allowedMutations = new Set<MutationKind>();
    /** 无 sessionId 内存模式下的上一轮 ask_user 信息 */
    private lastTurnAskInfo: { question?: string; options?: string[] } | null = null;

    constructor(gateway: GatewayClient, modelConfig?: ModelConfig, maxContextTokens?: number) {
        this.gateway = gateway;
        this.modelConfig = modelConfig || getModelConfigFromEnv();
        const envMaxTokens = Number(process.env.LLM_MAX_CONTEXT_TOKENS || '');
        this.maxContextTokens = maxContextTokens
            || (Number.isFinite(envMaxTokens) && envMaxTokens >= 8000 ? envMaxTokens : Agent.DEFAULT_MAX_CONTEXT_TOKENS);

        this.tools = createCoreTools(gateway, {
            canMutateGraph: (kind?: MutationKind) => {
                if (!kind) return this.allowedMutations.size > 0;
                return this.allowedMutations.has(kind);
            },
            onAskUser: () => {
                // 一旦本轮调用了 ask_user，立即关闭写权限，防止同一步并行调用写工具偷跑
                this.allowedMutations.clear();
            },
        });

        // 渐进式披露第一层：只添加领域相关的 skill catalog（name + description）
        const skillsCatalog = formatSkillCatalogForPrompt({domainFilter: 'smart-home'});
        this.systemPrompt = buildSystemPrompt(this.modelConfig.customInstructions) + skillsCatalog;
    }

    /**
     * 设置当前 Session
     */
    setSession(sessionId: string): void {
        this.sessionId = sessionId;
    }

    /**
     * 加载 Session 历史到 messages
     */
    async loadSession(sessionId: string): Promise<void> {
        this.sessionId = sessionId;
        await this.reloadMessages();
    }

    /**
     * 从 sessionStore 重新加载消息到 messages
     * - 支持按真实多步 steps 还原 ReAct 因果序列（兼容旧扁平 toolCalls 数据）
     * - 自动对历史中重复激活的同一 Skill 执行无损 Observation Masking，节省重复上下文
     */
    private async reloadMessages(): Promise<void> {
        if (!this.sessionId) return;

        const allSessionMessages = await this.sessionStore.getMessages(this.sessionId);

        // 找到最后一条 compressed 消息的索引
        let compressedIndex = -1;
        for (let i = allSessionMessages.length - 1; i >= 0; i--) {
            if (allSessionMessages[i].role === 'compressed') {
                compressedIndex = i;
                break;
            }
        }

        const sessionMessages = compressedIndex >= 0
            ? allSessionMessages.slice(compressedIndex)
            : allSessionMessages;

        // 预先定位每个 Skill 最后一次被 activate_skill 成功加载的位置，用于屏蔽早期重复大文本
        let lastSkillCallKey = new Map<string, string>();
        for (let mIdx = 0; mIdx < sessionMessages.length; mIdx++) {
            const m = sessionMessages[mIdx];
            if (m.role !== 'assistant') continue;
            const calls = m.steps
                ? m.steps.flatMap((s, sIdx) => (s.toolCalls || []).map((tc, cIdx) => ({tc, key: `${mIdx}:${sIdx}:${cIdx}`})))
                : (m.toolCalls || []).map((tc, cIdx) => ({tc, key: `${mIdx}:0:${cIdx}`}));
            for (const {tc, key} of calls) {
                if (tc.tool === 'activate_skill' && tc.success && tc.args?.name) {
                    lastSkillCallKey.set(String(tc.args.name), key);
                }
            }
        }

        const maskToolResult = (tc: ToolCall, key: string): any => {
            if (
                tc.tool === 'activate_skill' &&
                tc.success &&
                tc.args?.name &&
                lastSkillCallKey.get(String(tc.args.name)) !== key
            ) {
                return {
                    success: true,
                    skill: tc.args.name,
                    omittedDuplicate: true,
                    message: `[Skill "${tc.args.name}" 已在后续轮次重新激活，此处省略重复正文]`,
                };
            }
            return tc.result;
        };

        this.messages = [];

        for (let mIdx = 0; mIdx < sessionMessages.length; mIdx++) {
            const msg = sessionMessages[mIdx];
            if (msg.role === 'compressed') {
                this.messages.push({
                    role: 'user',
                    content: `[以下是对之前对话的摘要]\n${msg.content}\n[摘要结束，请基于以上上下文继续对话]`,
                });
            } else if (msg.role === 'user') {
                this.messages.push({
                    role: 'user',
                    content: msg.content,
                });
            } else if (msg.role === 'assistant') {
                if (msg.steps && msg.steps.length > 0) {
                    const baseId = `call_${msg.seq}_${mIdx}`;
                    for (let sIdx = 0; sIdx < msg.steps.length; sIdx++) {
                        const step = msg.steps[sIdx];
                        const stepCalls = step.toolCalls || [];
                        if (stepCalls.length > 0) {
                            const assistantParts: any[] = [];
                            if (step.text) {
                                assistantParts.push({type: 'text' as const, text: step.text});
                            }
                            stepCalls.forEach((tc, cIdx) => {
                                assistantParts.push({
                                    type: 'tool-call' as const,
                                    toolCallId: tc.toolCallId || `${baseId}_${sIdx}_${cIdx}`,
                                    toolName: tc.tool,
                                    args: tc.args ?? {},
                                });
                            });
                            this.messages.push({role: 'assistant', content: assistantParts});
                            this.messages.push({
                                role: 'tool',
                                content: stepCalls.map((tc, cIdx) => ({
                                    type: 'tool-result' as const,
                                    toolCallId: tc.toolCallId || `${baseId}_${sIdx}_${cIdx}`,
                                    toolName: tc.tool,
                                    result: maskToolResult(tc, `${mIdx}:${sIdx}:${cIdx}`),
                                })),
                            });
                        } else if (step.text) {
                            this.messages.push({role: 'assistant', content: step.text});
                        }
                    }
                    // 若末尾步骤是工具调用且 msg.content 另有总结正文（兜底兼容），补充最终文本
                    const lastStep = msg.steps[msg.steps.length - 1];
                    if (msg.content && lastStep && (lastStep.toolCalls?.length ?? 0) > 0) {
                        this.messages.push({role: 'assistant', content: msg.content});
                    }
                } else if (msg.toolCalls && msg.toolCalls.length > 0) {
                    // 兼容旧版未记录 steps 的历史消息
                    const baseId = `call_${msg.seq}_${mIdx}`;
                    this.messages.push({
                        role: 'assistant',
                        content: msg.toolCalls.map((tc, i) => ({
                            type: 'tool-call' as const,
                            toolCallId: tc.toolCallId || `${baseId}_${i}`,
                            toolName: tc.tool,
                            args: tc.args ?? {},
                        })),
                    });
                    this.messages.push({
                        role: 'tool',
                        content: msg.toolCalls.map((tc, i) => ({
                            type: 'tool-result' as const,
                            toolCallId: tc.toolCallId || `${baseId}_${i}`,
                            toolName: tc.tool,
                            result: maskToolResult(tc, `${mIdx}:0:${i}`),
                        })),
                    });
                    if (msg.content) {
                        this.messages.push({role: 'assistant', content: msg.content});
                    }
                } else {
                    this.messages.push({
                        role: 'assistant',
                        content: msg.content,
                    });
                }
            }
        }
    }

    /**
     * 估算当前 messages 的 token 数
     * 中文 + JSON 混合场景按 1 token ≈ 3.0 字符保守估算
     */
    private estimateTokens(): number {
        let totalChars = (this.systemPrompt || '').length;

        for (const msg of this.messages) {
            if (typeof msg.content === 'string') {
                totalChars += msg.content.length;
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        totalChars += (part.text || '').length;
                    } else if (part.type === 'tool-call') {
                        totalChars += JSON.stringify(part.args ?? {}).length;
                    } else if (part.type === 'tool-result') {
                        totalChars += JSON.stringify(part.result ?? {}).length;
                    }
                }
            }
        }
        return Math.ceil(totalChars / 3.0);
    }

    private async getAllSessionMessages() {
        if (!this.sessionId) return [];
        return this.sessionStore.getMessages(this.sessionId);
    }

    /**
     * 压缩对话历史（包含工具调用产生的设备 DID、规则 ID 与关键变更摘要）
     */
    private async compressHistory(): Promise<void> {
        if (!this.sessionId) return;

        const allMessages = await this.getAllSessionMessages();

        let lastCompressedIndex = -1;
        for (let i = allMessages.length - 1; i >= 0; i--) {
            if (allMessages[i].role === 'compressed') {
                lastCompressedIndex = i;
                break;
            }
        }

        const previousSummary = lastCompressedIndex >= 0 ? allMessages[lastCompressedIndex].content : '';
        const currentMessages = lastCompressedIndex >= 0
            ? allMessages.slice(lastCompressedIndex + 1)
            : allMessages;

        const userMsgCount = currentMessages.filter(m => m.role === 'user').length;
        if (userMsgCount <= Agent.KEEP_RECENT_TURNS + 2) return;

        let cutoffSeq = -1;
        let recentUserCount = 0;
        for (let i = currentMessages.length - 1; i >= 0; i--) {
            if (currentMessages[i].role === 'user') {
                recentUserCount++;
                if (recentUserCount > Agent.KEEP_RECENT_TURNS) {
                    cutoffSeq = currentMessages[i].seq;
                    break;
                }
            }
        }

        if (cutoffSeq < 0) return;

        const toCompress = currentMessages.filter(m => m.seq < cutoffSeq);
        if (toCompress.length === 0) return;

        const historyLines: string[] = [];
        if (previousSummary) {
            historyLines.push(`[早期摘要] ${previousSummary}`);
        }
        for (const m of toCompress) {
            if (m.role === 'user') {
                historyLines.push(`用户: ${m.content}`);
            } else if (m.role === 'assistant') {
                const toolSummary = summarizeToolCallsForCompression(m.toolCalls);
                const parts = [
                    toolSummary ? `[工具记录: ${toolSummary}]` : '',
                    m.content || '',
                ].filter(Boolean).join(' ');
                if (parts) {
                    historyLines.push(`助手: ${parts}`);
                }
            }
        }

        const model = createModel(this.modelConfig);
        const summaryResult = await generateText({
            model,
            messages: [
                {
                    role: 'user',
                    content: `请将以下智能家居助手的对话历史压缩为结构化中文摘要（600 字以内），必须精确保留：
1. 已查询到的设备名称及其 DID、关键 siid/piid 或 URN
2. 已创建/修改/查询的自动化规则名称与规则 ID（graphId）
3. 已确认的用户偏好、命名约定与尚未完成的待办事项

对话历史：
${historyLines.join('\n')}`,
                },
            ],
            temperature: 0.1,
        });

        const summary = summaryResult.text.trim();
        if (!summary) return;

        await this.sessionStore.insertCompressedSummary(this.sessionId, summary);
        await this.reloadMessages();
    }

    private async saveUserMessage(content: string): Promise<void> {
        if (!this.sessionId) return;

        try {
            await this.sessionStore.appendMessage(this.sessionId, {
                role: 'user',
                content,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('保存用户消息失败:', error);
        }
    }

    private async saveAssistantMessage(
        content: string,
        thinking: string,
        toolCalls: ToolCall[],
        steps: SessionStep[],
        usage?: TurnUsage
    ): Promise<void> {
        if (!this.sessionId) return;

        try {
            await this.sessionStore.appendMessage(this.sessionId, {
                role: 'assistant',
                content,
                timestamp: new Date().toISOString(),
                thinking: thinking || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                steps: steps.length > 0 ? steps : undefined,
                usage,
            });
        } catch (error) {
            console.error('保存助手消息失败:', error);
        }
    }

    /**
     * Agent 主循环
     * 返回异步生成器，实时区分推理过程（thinking）与最终回复流（text）
     */
    async* run(userInput?: string, runOptions?: AgentRunOptions): AsyncGenerator<AgentOutput> {
        const startTime = Date.now();
        try {
            await this.reloadMessages();

            // 根据上一轮助手是否发起了 ask_user 及本轮用户是否确认/拒绝，精细计算写操作授权集合
            const askInfo = this.sessionId
                ? findAskUserInLastAssistantTurn(this.messages)
                : this.lastTurnAskInfo;
            this.allowedMutations = userInput
                ? resolveAllowedMutations(askInfo, userInput)
                : new Set<MutationKind>();

            if (userInput) {
                this.messages.push({role: 'user', content: userInput});
                await this.saveUserMessage(userInput);
            }

            const estimatedTokens = this.estimateTokens();
            if (estimatedTokens > this.maxContextTokens && this.sessionId) {
                try {
                    await this.compressHistory();
                } catch (compressError) {
                    console.error('对话历史压缩失败，继续执行:', compressError);
                }
            }

            const model = createModel(this.modelConfig);
            const abortController = new AbortController();
            const externalSignal = runOptions?.abortSignal;
            const onExternalAbort = () => abortController.abort();
            if (externalSignal) {
                if (externalSignal.aborted) {
                    return;
                }
                externalSignal.addEventListener('abort', onExternalAbort, {once: true});
            }

            try {
                // Anthropic 模型开启系统提示词缓存，降低多步工具循环的重复输入成本
                const systemMessages: CoreMessage[] | undefined = this.modelConfig.provider === 'anthropic'
                    ? [{
                        role: 'system',
                        content: this.systemPrompt,
                        experimental_providerMetadata: {
                            anthropic: {cacheControl: {type: 'ephemeral'}},
                        },
                    } as CoreMessage]
                    : undefined;

                const result = await streamText({
                    model,
                    ...(systemMessages ? {messages: [...systemMessages, ...this.messages]} : {
                        system: this.systemPrompt,
                        messages: this.messages,
                    }),
                    tools: this.tools,
                    maxSteps: 15,
                    temperature: this.modelConfig.temperature ?? 0.2,
                    abortSignal: abortController.signal,
                });

                let finalContent = '';
                let thinkingText = '';
                const allToolCalls: ToolCall[] = [];
                const recordedSteps: SessionStep[] = [];

                // 当前 Step 的局部缓冲：
                // - 若本步没有调工具就结束，stepText 就是最终正文回复（已通过 text 事件实时流式输出）
                // - 若本步发起了工具调用，stepText 归入过渡思考过程（thinkingText）
                let stepText = '';
                let stepReasoning = '';
                let stepHasToolCall = false;
                let stepToolCalls: ToolCall[] = [];

                let needsUserInput = false;
                let waitingQuestion: string | undefined;
                let waitingOptions: string[] | undefined;
                let latestAskInfo: { question?: string; options?: string[] } | null = null;

                let totalPromptTokens = 0;
                let totalCompletionTokens = 0;
                let stepCount = 0;

                const pendingToolCalls = new Map<string, { tool: string; args: any }>();

                for await (const chunk of result.fullStream as AsyncIterable<any>) {
                    if (externalSignal?.aborted) {
                        abortController.abort();
                        return;
                    }

                    switch (chunk.type) {
                        case 'reasoning': {
                            const delta = chunk.textDelta || '';
                            if (delta) {
                                stepReasoning += delta;
                                thinkingText += delta;
                                yield {type: 'thinking', content: delta};
                            }
                            break;
                        }

                        case 'text-delta': {
                            const delta = chunk.textDelta || '';
                            if (!delta) break;
                            stepText += delta;
                            if (stepHasToolCall) {
                                // 同一步已经开始调工具，附带文本属于过渡推理
                                thinkingText += delta;
                                yield {type: 'thinking', content: delta};
                            } else {
                                // 实时流式推送正文，前端若随后遇到 tool_start 会自动将其移入思考链
                                yield {type: 'text', content: delta};
                            }
                            break;
                        }

                        case 'tool-call': {
                            if (!stepHasToolCall && stepText) {
                                // 此前本步已流出的文本实际是调用工具前的过渡说明，计入持久化思考记录
                                thinkingText += (thinkingText ? '\n' : '') + stepText;
                            }
                            stepHasToolCall = true;
                            pendingToolCalls.set(chunk.toolCallId, {
                                tool: chunk.toolName,
                                args: chunk.args,
                            });
                            if (chunk.toolName === 'think' && typeof chunk.args?.thought === 'string' && chunk.args.thought) {
                                thinkingText += (thinkingText ? '\n' : '') + chunk.args.thought;
                            }
                            yield {
                                type: 'tool_start',
                                toolCallId: chunk.toolCallId,
                                tool: chunk.toolName,
                                args: chunk.args,
                            };
                            break;
                        }

                        case 'tool-result': {
                            const started = pendingToolCalls.get(chunk.toolCallId);
                            pendingToolCalls.delete(chunk.toolCallId);
                            const toolCall: ToolCall = {
                                toolCallId: chunk.toolCallId,
                                tool: started?.tool || chunk.toolName,
                                args: started?.args ?? {},
                                result: chunk.result,
                                success: chunk.result?.success !== false,
                            };
                            allToolCalls.push(toolCall);
                            stepToolCalls.push(toolCall);

                            yield {
                                type: 'tool_result',
                                toolCallId: chunk.toolCallId,
                                tool: chunk.toolName,
                                result: chunk.result,
                            };

                            if (chunk.result?.needsUserInput) {
                                needsUserInput = true;
                                waitingQuestion = chunk.result.question;
                                waitingOptions = chunk.result.options;
                                latestAskInfo = {
                                    question: waitingQuestion,
                                    options: waitingOptions,
                                };
                            }
                            break;
                        }

                        case 'step-finish': {
                            stepCount++;
                            if (chunk.usage) {
                                if (typeof chunk.usage.promptTokens === 'number') {
                                    totalPromptTokens += chunk.usage.promptTokens;
                                }
                                if (typeof chunk.usage.completionTokens === 'number') {
                                    totalCompletionTokens += chunk.usage.completionTokens;
                                }
                            }

                            if (stepHasToolCall || stepToolCalls.length > 0) {
                                recordedSteps.push({
                                    text: stepText || undefined,
                                    reasoning: stepReasoning || undefined,
                                    toolCalls: stepToolCalls,
                                });
                            } else if (stepText || stepReasoning) {
                                finalContent += stepText;
                                recordedSteps.push({
                                    text: stepText || undefined,
                                    reasoning: stepReasoning || undefined,
                                });
                            }

                            stepText = '';
                            stepReasoning = '';
                            stepHasToolCall = false;
                            stepToolCalls = [];

                            if (needsUserInput) {
                                abortController.abort();
                                this.lastTurnAskInfo = latestAskInfo;
                                const usage: TurnUsage = {
                                    promptTokens: totalPromptTokens || undefined,
                                    completionTokens: totalCompletionTokens || undefined,
                                    totalTokens: (totalPromptTokens + totalCompletionTokens) || undefined,
                                    durationMs: Date.now() - startTime,
                                    stepCount,
                                };
                                await this.saveAssistantMessage(finalContent, thinkingText, allToolCalls, recordedSteps, usage);
                                await this.reloadMessages();

                                yield {
                                    type: 'waiting_input',
                                    question: waitingQuestion,
                                    options: waitingOptions,
                                };
                                return;
                            }
                            break;
                        }

                        case 'finish': {
                            if (stepText && !stepHasToolCall) {
                                finalContent += stepText;
                                recordedSteps.push({text: stepText, reasoning: stepReasoning || undefined});
                                stepText = '';
                            }
                            this.lastTurnAskInfo = null;
                            const pTokens = totalPromptTokens || chunk.usage?.promptTokens || 0;
                            const cTokens = totalCompletionTokens || chunk.usage?.completionTokens || 0;
                            const usage: TurnUsage = {
                                promptTokens: pTokens || undefined,
                                completionTokens: cTokens || undefined,
                                totalTokens: (pTokens + cTokens) || undefined,
                                durationMs: Date.now() - startTime,
                                stepCount: stepCount || 1,
                            };
                            await this.saveAssistantMessage(finalContent, thinkingText, allToolCalls, recordedSteps, usage);
                            await this.reloadMessages();

                            yield {type: 'complete', message: finalContent, usage};
                            return;
                        }

                        case 'error':
                            yield {type: 'error', error: String(chunk.error)};
                            return;
                    }
                }

                // 兜底：若底层流结束但未发出 finish 事件
                if (!externalSignal?.aborted) {
                    if (stepText && !stepHasToolCall) {
                        finalContent += stepText;
                        recordedSteps.push({text: stepText, reasoning: stepReasoning || undefined});
                    }
                    this.lastTurnAskInfo = null;
                    const usage: TurnUsage = {
                        durationMs: Date.now() - startTime,
                        stepCount: stepCount || (recordedSteps.length || 1),
                    };
                    await this.saveAssistantMessage(finalContent, thinkingText, allToolCalls, recordedSteps, usage);
                    await this.reloadMessages();

                    yield {type: 'complete', message: finalContent, usage};
                }
            } finally {
                if (externalSignal) {
                    externalSignal.removeEventListener('abort', onExternalAbort);
                }
            }
        } catch (error: any) {
            if (runOptions?.abortSignal?.aborted || error?.name === 'AbortError') {
                return;
            }
            yield {type: 'error', error: String(error)};
            console.error('Agent run got error:', error);
        }
    }

    /**
     * 简化版 run 方法
     * 返回完整响应（非流式）
     */
    async chat(userInput: string): Promise<string> {
        let response = '';

        for await (const output of this.run(userInput)) {
            if (output.type === 'text') {
                response += output.content;
            } else if (output.type === 'complete') {
                response = output.message || response;
            } else if (output.type === 'error') {
                throw new Error(output.error);
            }
        }

        return response;
    }

    getHistory(): CoreMessage[] {
        return [...this.messages];
    }

    clear(): void {
        this.messages = [];
    }

    setModelConfig(config: ModelConfig): void {
        this.modelConfig = config;
        const skillsCatalog = formatSkillCatalogForPrompt({domainFilter: 'smart-home'});
        this.systemPrompt = buildSystemPrompt(this.modelConfig.customInstructions) + skillsCatalog;
    }

    getModelConfig(): ModelConfig {
        return this.modelConfig;
    }
}
