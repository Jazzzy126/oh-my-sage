'use client';

import React, {useState, useRef, useEffect, useCallback, useMemo} from 'react';
import {message} from 'antd';
import {
    ApartmentOutlined,
    AppstoreOutlined,
    ArrowUpOutlined,
    BulbOutlined,
    CheckOutlined,
    CopyOutlined,
    DownOutlined,
    RightOutlined,
    RollbackOutlined,
    SearchOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Chat.module.css';

interface AgentOutput {
    type: 'thinking' | 'tool_start' | 'tool_result' | 'complete' | 'waiting_input' | 'error';
    content?: string;
    tool?: string;
    args?: any;
    result?: any;
    question?: string;
    options?: string[];
    error?: string;
    message?: string;
}

interface ToolCallItem {
    tool: string;
    args?: any;
    result?: any;
    success: boolean;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    seq?: number;
    process?: {
        toolCalls: ToolCallItem[];
        thinking: string;
    };
}

interface SessionMessage {
    seq: number;
    role: 'user' | 'assistant' | 'compressed';
    content: string;
    timestamp: string;
    thinking?: string;
    toolCalls?: ToolCallItem[];
}

interface MentionDevice {
    did: string;
    name: string;
    model?: string;
    online: boolean;
    roomName?: string;
}

interface MentionGraph {
    id: string;
    name: string;
    enable: boolean;
}

type MentionTab = 'all' | 'device' | 'graph';

interface MentionOption {
    key: string;
    kind: 'device' | 'graph';
    title: string;
    meta: string;
    active: boolean;
    insertText: string;
}

interface ChatProps {
    passcode?: string;
    sessionId?: string;
    initialMessages?: SessionMessage[];
    draftInsert?: { text: string; seq: number } | null;
    devices?: MentionDevice[];
    graphs?: MentionGraph[];
    graphsLoading?: boolean;
    onEnsureGraphsLoaded?: () => void;
    onSessionCreated?: (sessionId: string, messages: SessionMessage[]) => void;
    onResetSession?: (sessionId: string, seq: number) => Promise<void>;
    onGraphsMutated?: () => void;
}

const MENTION_TRIGGER_RE = /(?:^|[\s，。！？、；：（(\[])(@([^\s@]*))$/;

const GRAPH_WRITE_TOOL_RE = /(create|update|patch|put|delete|toggle)_?graph/i;

const STARTER_PROMPTS = [
    {
        key: 'devices',
        tone: 'warm' as const,
        label: '查看当前设备状态',
        hint: '列出在线设备与房间分布，确认可联动能力',
        prompt: '帮我查看设备状态',
    },
    {
        key: 'create',
        tone: 'signal' as const,
        label: '创建一条自动化规则',
        hint: '用自然语言描述触发条件与设备动作，自动生成规则',
        prompt: '帮我创建自动化规则',
    },
    {
        key: 'rules',
        tone: 'info' as const,
        label: '检查现有自动化规则',
        hint: '查看中枢网关中已有的规则及启用情况',
        prompt: '帮我查看当前的自动化规则列表',
    },
];

let messageIdCounter = 0;

function generateMessageId(): string {
    return `msg_${Date.now()}_${++messageIdCounter}`;
}

function extractText(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return extractText(node.props.children);
    }
    return '';
}

function CopyablePre({children, ...props}: React.ComponentPropsWithoutRef<'pre'>) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        const text = extractText(children).replace(/\n$/, '');
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            // 忽略剪贴板权限受限
        }
    };

    return (
        <div className={styles.codeBlockWrap}>
            <button type="button" className={styles.codeCopyButton} onClick={handleCopy}>
                {copied ? <CheckOutlined style={{fontSize: 11}}/> : <CopyOutlined style={{fontSize: 11}}/>}
                <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <pre {...props}>{children}</pre>
        </div>
    );
}

const MARKDOWN_COMPONENTS = {
    pre: CopyablePre,
};

function AssistantMark() {
    return (
        <span className={styles.assistantAvatar} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="2" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="7" cy="7" r="2" fill="var(--ui-signal)"/>
            </svg>
        </span>
    );
}

export default function Chat({
    passcode: propPasscode,
    sessionId,
    initialMessages,
    draftInsert,
    devices = [],
    graphs = [],
    graphsLoading = false,
    onEnsureGraphsLoaded,
    onSessionCreated,
    onResetSession,
    onGraphsMutated,
}: ChatProps = {}) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [waitingInput, setWaitingInput] = useState<{ question: string; options: string[] } | null>(null);
    const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(sessionId);
    const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
    const [showScrollBottom, setShowScrollBottom] = useState(false);

    // @ 引用弹窗状态：button 模式由左侧按钮触发，inline 模式由输入 @ 触发
    const [mentionMode, setMentionMode] = useState<'closed' | 'button' | 'inline'>('closed');
    const [mentionTab, setMentionTab] = useState<MentionTab>('all');
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);

    const [streamThinking, setStreamThinking] = useState('');
    const [streamToolCalls, setStreamToolCalls] = useState<ToolCallItem[]>([]);
    const [streamFinalContent, setStreamFinalContent] = useState('');

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const mentionSearchRef = useRef<HTMLInputElement>(null);
    const mentionListRef = useRef<HTMLDivElement>(null);
    const savedCursorRef = useRef<number | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const isNearBottomRef = useRef(true);
    const passcode = propPasscode || '';
    const prevSessionIdRef = useRef<string | undefined>(sessionId);
    const initializedRef = useRef(false);

    useEffect(() => {
        if (sessionId !== prevSessionIdRef.current) {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            setStreamThinking('');
            setStreamToolCalls([]);
            setStreamFinalContent('');
            setWaitingInput(null);
            setIsLoading(false);
            setCurrentSessionId(sessionId);
            prevSessionIdRef.current = sessionId;
            initializedRef.current = false;
        }
    }, [sessionId]);

    useEffect(() => {
        if (initializedRef.current) return;

        if (initialMessages && initialMessages.length > 0) {
            const visibleMessages = initialMessages.filter(
                (m): m is SessionMessage & { role: 'user' | 'assistant' } => m.role !== 'compressed'
            );
            const convertedMessages: ChatMessage[] = visibleMessages.map(msg => ({
                id: generateMessageId(),
                role: msg.role,
                content: msg.content || '',
                seq: msg.seq,
                process: (msg.toolCalls && msg.toolCalls.length > 0) || msg.thinking ? {
                    toolCalls: (msg.toolCalls || []).map(tc => ({
                        tool: tc.tool || '',
                        args: tc.args,
                        result: tc.result,
                        success: tc.success !== false,
                    })),
                    thinking: msg.thinking || '',
                } : undefined,
            }));
            setMessages(convertedMessages);
            initializedRef.current = true;
        } else if (initialMessages && initialMessages.length === 0 && !isLoading) {
            setMessages([]);
            initializedRef.current = true;
        }
    }, [initialMessages, isLoading]);

    // 仅在用户接近底部时自动跟随滚动，避免向上翻看历史时被抢滚动条
    useEffect(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        if (isNearBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [messages, streamThinking, streamToolCalls, streamFinalContent, waitingInput]);

    // 接收来自设备/规则面板的快捷引用文本并聚焦输入框
    useEffect(() => {
        if (!draftInsert?.text) return;
        setInput(prev => {
            if (!prev.trim()) return draftInsert.text;
            const sep = prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' ';
            return `${prev}${sep}${draftInsert.text}`;
        });
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
            }
        });
    }, [draftInsert]);

    const handleMessagesScroll = () => {
        const el = messagesContainerRef.current;
        if (!el) return;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nearBottom = distanceToBottom < 80;
        isNearBottomRef.current = nearBottom;
        setShowScrollBottom(!nearBottom && el.scrollHeight > el.clientHeight + 120);
    };

    const scrollToBottom = () => {
        const el = messagesContainerRef.current;
        if (!el) return;
        isNearBottomRef.current = true;
        setShowScrollBottom(false);
        el.scrollTo({top: el.scrollHeight, behavior: 'smooth'});
    };

    // 自动调整输入框高度
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    }, [input]);

    const mentionOpen = mentionMode !== 'closed';

    const closeMention = useCallback(() => {
        setMentionMode('closed');
        setMentionQuery('');
        setMentionRange(null);
        setMentionIndex(0);
    }, []);

    // 点击输入区外部时关闭 @ 引用弹窗
    useEffect(() => {
        if (!mentionOpen) return;
        const onPointerDown = (e: MouseEvent) => {
            if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
                closeMention();
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [mentionOpen, closeMention]);

    // 通过按钮打开时自动聚焦弹窗搜索框
    useEffect(() => {
        if (mentionMode === 'button') {
            requestAnimationFrame(() => mentionSearchRef.current?.focus());
        }
    }, [mentionMode]);

    // 合并并筛选可引用的设备与自动化规则
    const mentionOptions = useMemo<MentionOption[]>(() => {
        const kw = mentionQuery.trim().toLowerCase();
        const items: MentionOption[] = [];

        if (mentionTab === 'all' || mentionTab === 'device') {
            for (const dev of devices) {
                const room = dev.roomName || '未分组';
                if (kw) {
                    const hitName = dev.name.toLowerCase().includes(kw);
                    const hitRoom = room.toLowerCase().includes(kw);
                    const hitModel = (dev.model || '').toLowerCase().includes(kw);
                    if (!hitName && !hitRoom && !hitModel) continue;
                }
                items.push({
                    key: `device:${dev.did}`,
                    kind: 'device',
                    title: dev.name,
                    meta: `${room} · ${dev.online ? '在线' : '离线'}`,
                    active: dev.online,
                    insertText: `「${dev.name}」`,
                });
            }
        }

        if (mentionTab === 'all' || mentionTab === 'graph') {
            for (const g of graphs) {
                if (kw && !g.name.toLowerCase().includes(kw) && !g.id.toLowerCase().includes(kw)) {
                    continue;
                }
                items.push({
                    key: `graph:${g.id}`,
                    kind: 'graph',
                    title: g.name,
                    meta: `自动化规则 · ${g.enable ? '已启用' : '已停用'}`,
                    active: g.enable,
                    insertText: `「${g.name}」（规则 ID: ${g.id}）`,
                });
            }
        }

        return items;
    }, [devices, graphs, mentionQuery, mentionTab]);

    useEffect(() => {
        setMentionIndex(0);
    }, [mentionQuery, mentionTab, mentionMode]);

    useEffect(() => {
        if (!mentionOpen) return;
        const container = mentionListRef.current;
        const activeEl = container?.querySelector<HTMLElement>(`[data-mention-index="${mentionIndex}"]`);
        activeEl?.scrollIntoView({block: 'nearest'});
    }, [mentionIndex, mentionOpen]);

    const handleSelectMention = useCallback((option: MentionOption) => {
        const textToInsert = `${option.insertText} `;
        let nextCursor = 0;

        if (mentionMode === 'inline' && mentionRange) {
            setInput(prev => {
                const before = prev.slice(0, mentionRange.start);
                const after = prev.slice(mentionRange.end);
                nextCursor = before.length + textToInsert.length;
                return `${before}${textToInsert}${after}`;
            });
        } else {
            setInput(prev => {
                const pos = savedCursorRef.current !== null
                    ? Math.min(savedCursorRef.current, prev.length)
                    : prev.length;
                const before = prev.slice(0, pos);
                const after = prev.slice(pos);
                const prefix = before && !/[\s，。！？、；：（(\[]$/.test(before) ? ' ' : '';
                const inserted = `${prefix}${textToInsert}`;
                nextCursor = before.length + inserted.length;
                return `${before}${inserted}${after}`;
            });
        }

        closeMention();
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = nextCursor;
            }
        });
    }, [mentionMode, mentionRange, closeMention]);

    const handleToggleMentionButton = () => {
        if (mentionMode === 'button') {
            closeMention();
            textareaRef.current?.focus();
            return;
        }
        savedCursorRef.current = textareaRef.current?.selectionStart ?? input.length;
        setMentionTab('all');
        setMentionQuery('');
        setMentionRange(null);
        setMentionMode('button');
        onEnsureGraphsLoaded?.();
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        const cursor = e.target.selectionStart ?? value.length;
        setInput(value);

        const beforeCursor = value.slice(0, cursor);
        const match = MENTION_TRIGGER_RE.exec(beforeCursor);
        if (match) {
            const token = match[1];
            const query = match[2];
            setMentionRange({start: cursor - token.length, end: cursor});
            setMentionQuery(query);
            if (mentionMode !== 'inline') {
                setMentionTab('all');
                setMentionMode('inline');
                onEnsureGraphsLoaded?.();
            }
        } else if (mentionMode === 'inline') {
            closeMention();
        }
    };

    const handleMentionNavigationKey = (e: React.KeyboardEvent): boolean => {
        if (!mentionOpen) return false;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMention();
            textareaRef.current?.focus();
            return true;
        }
        if (mentionOptions.length === 0) return false;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setMentionIndex(prev => (prev + 1) % mentionOptions.length);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setMentionIndex(prev => (prev - 1 + mentionOptions.length) % mentionOptions.length);
            return true;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
            if (e.nativeEvent instanceof KeyboardEvent && e.nativeEvent.isComposing) return false;
            e.preventDefault();
            handleSelectMention(mentionOptions[mentionIndex] || mentionOptions[0]);
            return true;
        }
        return false;
    };

    const sendMessage = useCallback(async (messageText: string) => {
        if (!messageText.trim() || isLoading) return;

        const userMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'user',
            content: messageText,
        };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);
        setWaitingInput(null);
        isNearBottomRef.current = true;
        setShowScrollBottom(false);

        let currentThinking = '';
        const currentToolCalls: ToolCallItem[] = [];
        let finalContent = '';
        setStreamThinking('');
        setStreamToolCalls([]);
        setStreamFinalContent('');

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({message: messageText, passcode, sessionId: currentSessionId}),
                signal: abortController.signal,
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const reader = response.body?.getReader();
            if (!reader) throw new Error('无法读取响应流');

            const decoder = new TextDecoder();

            while (true) {
                if (abortController.signal.aborted) {
                    reader.cancel();
                    break;
                }
                const {done, value} = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const output: AgentOutput = JSON.parse(data);
                        switch (output.type) {
                            case 'thinking':
                                currentThinking += output.content || '';
                                setStreamThinking(currentThinking);
                                break;
                            case 'tool_start':
                                currentToolCalls.push({tool: output.tool || '', args: output.args, success: false});
                                setStreamToolCalls([...currentToolCalls]);
                                break;
                            case 'tool_result': {
                                const lastIndex = currentToolCalls.length - 1;
                                if (lastIndex >= 0) {
                                    currentToolCalls[lastIndex].success = output.result?.success !== false;
                                    currentToolCalls[lastIndex].result = output.result;
                                    setStreamToolCalls([...currentToolCalls]);
                                }
                                break;
                            }
                            case 'complete':
                                finalContent = output.message || output.content || '';
                                setStreamFinalContent(finalContent);
                                break;
                            case 'waiting_input': {
                                const opts = Array.isArray(output.options) ? output.options : [];
                                if (opts.length > 0) {
                                    setWaitingInput({question: output.question || '请选择', options: opts});
                                }
                                break;
                            }
                            case 'error':
                                message.error(output.error || '发生错误');
                                break;
                        }
                    } catch (parseError) {
                        if (data.length > 2) {
                            console.warn('流式数据解析失败:', data, parseError);
                        }
                    }
                }
            }

            if (abortController.signal.aborted) return;

            if (!currentSessionId) {
                const sessionsResponse = await fetch('/api/sessions');
                const sessionsData = await sessionsResponse.json();
                if (sessionsData.success && sessionsData.sessions.length > 0) {
                    const newSessionId = sessionsData.sessions[0].id;
                    setCurrentSessionId(newSessionId);
                    const assistantSessionMessage: SessionMessage = {
                        seq: 1,
                        role: 'assistant',
                        content: finalContent,
                        timestamp: new Date().toISOString(),
                        thinking: currentThinking || undefined,
                        toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
                    };
                    const userSessionMessage: SessionMessage = {
                        seq: 0,
                        role: 'user',
                        content: messageText,
                        timestamp: new Date().toISOString(),
                    };
                    onSessionCreated?.(newSessionId, [userSessionMessage, assistantSessionMessage]);
                }
            }

            const assistantMessage: ChatMessage = {
                id: generateMessageId(),
                role: 'assistant',
                content: finalContent,
                process: currentToolCalls.length > 0 || currentThinking ? {
                    toolCalls: currentToolCalls,
                    thinking: currentThinking,
                } : undefined,
            };
            setMessages(prev => [...prev, assistantMessage]);
            setStreamThinking('');
            setStreamToolCalls([]);
            setStreamFinalContent('');

            // 若本轮调用了规则写操作工具，通知外层自动刷新规则列表
            if (currentToolCalls.some(tc => tc.success && GRAPH_WRITE_TOOL_RE.test(tc.tool))) {
                onGraphsMutated?.();
            }
        } catch (error: any) {
            if (error.name === 'AbortError') return;
            setInput(messageText);
            setMessages(prev => prev.filter(m => m.id !== userMessage.id));
            message.error('发送失败: ' + error.message);
        } finally {
            abortControllerRef.current = null;
            setIsLoading(false);
        }
    }, [isLoading, passcode, currentSessionId, onSessionCreated, onGraphsMutated]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;
        if (waitingInput) setWaitingInput(null);
        sendMessage(input);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (mentionMode === 'inline' && handleMentionNavigationKey(e)) {
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (input.trim() && !isLoading) {
                if (waitingInput) setWaitingInput(null);
                sendMessage(input);
            }
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setIsLoading(false);
        setStreamThinking('');
        setStreamToolCalls([]);
        setStreamFinalContent('');
        setWaitingInput(null);
    };

    const handleReset = useCallback(async (targetSeq: number, messageContent: string) => {
        if (!currentSessionId || !onResetSession) return;
        handleStop();
        try {
            await onResetSession(currentSessionId, targetSeq - 1);
            setInput(messageContent);
            initializedRef.current = false;
        } catch {
            // 错误提示已在外层处理
        }
    }, [currentSessionId, onResetSession]);

    const renderMarkdown = (content: string) => {
        if (!content) return null;
        return (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {content}
            </ReactMarkdown>
        );
    };

    const handleCopyMessage = async (msgId: string, content: string) => {
        try {
            await navigator.clipboard.writeText(content);
            setCopiedMsgId(msgId);
            setTimeout(() => {
                setCopiedMsgId(prev => (prev === msgId ? null : prev));
            }, 1600);
        } catch {
            // 忽略剪贴板权限受限
        }
    };

    const renderProcess = (
        idPrefix: string,
        thinking: string,
        toolCalls: ToolCallItem[],
        streaming: boolean
    ) => (
        <details
            className={`${styles.processBox} ${streaming ? styles.processBoxStreaming : ''}`}
            open={streaming}
        >
            <summary className={styles.processSummary}>
                <RightOutlined className={styles.processChevron} style={{fontSize: 10}}/>
                {streaming && <span className={styles.spinner} aria-hidden="true"/>}
                <span className={styles.processTitle}>
                    {streaming ? '正在执行' : '执行过程'}
                </span>
                {toolCalls.map((tc, i) => {
                    const chipClass = tc.success
                        ? styles.toolChipOk
                        : tc.result !== undefined
                            ? styles.toolChipErr
                            : '';
                    return (
                        <span key={`${idPrefix}-chip-${i}`} className={`${styles.toolChip} ${chipClass}`}>
                            {tc.tool}
                        </span>
                    );
                })}
            </summary>

            <div className={styles.processBody}>
                {thinking && (
                    <div className={styles.thinkingBlock}>
                        <div className={styles.thinkingLabel}>思考过程</div>
                        <div>{thinking}</div>
                    </div>
                )}
                {toolCalls.map((tc, i) => {
                    const statusLabel = tc.success ? '完成' : tc.result !== undefined ? '失败' : '执行中';
                    const statusClass = tc.success
                        ? styles.toolCardStatusOk
                        : tc.result !== undefined
                            ? styles.toolCardStatusErr
                            : '';
                    return (
                        <div key={`${idPrefix}-tool-${i}`} className={styles.toolCard}>
                            <div className={styles.toolCardHeader}>
                                <span className={styles.toolCardName}>{tc.tool}</span>
                                <span className={`${styles.toolCardStatus} ${statusClass}`}>
                                    {statusLabel}
                                </span>
                            </div>
                            {tc.args && Object.keys(tc.args).length > 0 && (
                                <pre className={styles.toolCode}>{JSON.stringify(tc.args, null, 2)}</pre>
                            )}
                            {tc.result !== undefined && (
                                <pre className={styles.toolCode}>
                                    {typeof tc.result === 'object'
                                        ? JSON.stringify(tc.result, null, 2)
                                        : String(tc.result)}
                                </pre>
                            )}
                        </div>
                    );
                })}
            </div>
        </details>
    );

    const renderAssistantMessage = (msg: ChatMessage) => {
        const toolCalls = msg.process?.toolCalls || [];
        const hasProcess = Boolean(msg.process && (toolCalls.length > 0 || msg.process.thinking));

        return (
            <div key={msg.id} className={styles.assistantRow}>
                <AssistantMark/>
                <div className={styles.assistantBody}>
                    {hasProcess && renderProcess(msg.id, msg.process!.thinking, toolCalls, false)}
                    {msg.content && (
                        <>
                            <div className={`${styles.assistantProse} markdown-content`}>
                                {renderMarkdown(msg.content)}
                            </div>
                            <div className={styles.assistantFooter}>
                                <button
                                    type="button"
                                    className={`${styles.copyAction} ${
                                        copiedMsgId === msg.id ? styles.copyActionCopied : ''
                                    }`}
                                    onClick={() => handleCopyMessage(msg.id, msg.content)}
                                >
                                    {copiedMsgId === msg.id ? (
                                        <CheckOutlined style={{fontSize: 12}}/>
                                    ) : (
                                        <CopyOutlined style={{fontSize: 12}}/>
                                    )}
                                    <span>{copiedMsgId === msg.id ? '已复制' : '复制'}</span>
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    };

    const renderStreaming = () => {
        if (!isLoading) return null;
        const hasContent = Boolean(streamThinking || streamToolCalls.length > 0 || streamFinalContent);

        return (
            <div className={styles.assistantRow}>
                <AssistantMark/>
                <div className={styles.assistantBody}>
                    {!hasContent ? (
                        <div className={styles.typingDots} aria-label="助手正在思考">
                            <span/><span/><span/>
                        </div>
                    ) : (
                        <>
                            {(streamThinking || streamToolCalls.length > 0) &&
                                renderProcess('stream', streamThinking, streamToolCalls, true)}
                            {streamFinalContent && (
                                <div className={`${styles.assistantProse} markdown-content`}>
                                    {renderMarkdown(streamFinalContent)}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        );
    };

    const onlineDeviceCount = useMemo(
        () => devices.filter(d => d.online).length,
        [devices]
    );
    const enabledGraphCount = useMemo(
        () => graphs.filter(g => g.enable).length,
        [graphs]
    );

    const isEmptyConversation = messages.length === 0 && !isLoading;

    const renderComposer = (centered: boolean) => (
        <div className={centered ? styles.composerCentered : styles.composerWrap}>
            <form className={styles.composerForm} onSubmit={handleSubmit}>
                <div className={styles.composerAnchor} ref={composerRef}>
                    {mentionOpen && (
                        <div className={styles.mentionPopover} role="dialog" aria-label="引用设备或自动化规则">
                            <div className={styles.mentionHeader}>
                                <div className={styles.mentionTabs} role="tablist" aria-label="引用分类">
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={mentionTab === 'all'}
                                        className={`${styles.mentionTab} ${
                                            mentionTab === 'all' ? styles.mentionTabActive : ''
                                        }`}
                                        onClick={() => setMentionTab('all')}
                                    >
                                        全部
                                    </button>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={mentionTab === 'device'}
                                        className={`${styles.mentionTab} ${
                                            mentionTab === 'device' ? styles.mentionTabActive : ''
                                        }`}
                                        onClick={() => setMentionTab('device')}
                                    >
                                        设备
                                        {devices.length > 0 && (
                                            <span className={styles.mentionTabCount}>{devices.length}</span>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={mentionTab === 'graph'}
                                        className={`${styles.mentionTab} ${
                                            mentionTab === 'graph' ? styles.mentionTabActive : ''
                                        }`}
                                        onClick={() => setMentionTab('graph')}
                                    >
                                        自动化规则
                                        {graphs.length > 0 && (
                                            <span className={styles.mentionTabCount}>{graphs.length}</span>
                                        )}
                                    </button>
                                </div>

                                {mentionMode === 'button' && (
                                    <div className={styles.mentionSearchBox}>
                                        <SearchOutlined className={styles.mentionSearchIcon} style={{fontSize: 12}}/>
                                        <input
                                            ref={mentionSearchRef}
                                            type="text"
                                            className={styles.mentionSearchInput}
                                            placeholder="搜索设备、房间或规则"
                                            value={mentionQuery}
                                            onChange={(e) => setMentionQuery(e.target.value)}
                                            onKeyDown={handleMentionNavigationKey}
                                            aria-label="搜索要引用的设备或规则"
                                        />
                                    </div>
                                )}
                            </div>

                            <div className={styles.mentionList} ref={mentionListRef} role="listbox">
                                {mentionOptions.length === 0 ? (
                                    <div className={styles.mentionEmpty}>
                                        {mentionTab === 'graph' && graphsLoading
                                            ? '正在加载自动化规则…'
                                            : mentionQuery.trim()
                                                ? '没有匹配的设备或规则'
                                                : '暂无可引用项'}
                                    </div>
                                ) : (
                                    mentionOptions.map((opt, idx) => (
                                        <button
                                            key={opt.key}
                                            type="button"
                                            role="option"
                                            aria-selected={idx === mentionIndex}
                                            data-mention-index={idx}
                                            className={`${styles.mentionItem} ${
                                                idx === mentionIndex ? styles.mentionItemActive : ''
                                            }`}
                                            onMouseEnter={() => setMentionIndex(idx)}
                                            onMouseDown={(e) => {
                                                // 阻止失焦导致的选区丢失
                                                e.preventDefault();
                                                handleSelectMention(opt);
                                            }}
                                        >
                                            <span className={styles.mentionItemIcon} aria-hidden="true">
                                                {opt.kind === 'device' ? (
                                                    <AppstoreOutlined style={{fontSize: 13}}/>
                                                ) : (
                                                    <ApartmentOutlined style={{fontSize: 13}}/>
                                                )}
                                            </span>
                                            <span className={styles.mentionItemMain}>
                                                <span className={styles.mentionItemTitle}>{opt.title}</span>
                                                <span className={styles.mentionItemMeta}>{opt.meta}</span>
                                            </span>
                                            <span
                                                className={`${styles.mentionStatusDot} ${
                                                    opt.active ? styles.mentionStatusDotOn : ''
                                                }`}
                                                aria-hidden="true"
                                            />
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                    <div className={styles.composerBox}>
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            className={styles.textarea}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            placeholder={
                                waitingInput
                                    ? '选择上方选项，或输入自定义回复'
                                    : '问问智者，或输入 @ 引用设备与自动化规则'
                            }
                            disabled={isLoading && !waitingInput}
                            aria-label="消息输入框"
                        />

                        <div className={styles.composerToolbar}>
                            <button
                                type="button"
                                className={`${styles.mentionTrigger} ${
                                    mentionOpen ? styles.mentionTriggerActive : ''
                                }`}
                                onClick={handleToggleMentionButton}
                                disabled={isLoading && !waitingInput}
                                aria-haspopup="dialog"
                                aria-expanded={mentionOpen}
                                aria-label="引用设备或自动化规则"
                                title="引用设备或自动化规则 (@)"
                            >
                                <span className={styles.mentionAt}>@</span>
                                <span>引用设备或规则</span>
                            </button>

                            {isLoading ? (
                                <button
                                    type="button"
                                    className={styles.stopButton}
                                    onClick={handleStop}
                                    aria-label="停止生成"
                                    title="停止生成"
                                >
                                    <span className={styles.stopSquare} aria-hidden="true"/>
                                </button>
                            ) : (
                                <button
                                    type="submit"
                                    className={styles.sendButton}
                                    disabled={!input.trim()}
                                    aria-label="发送消息"
                                    title="发送 (Enter)"
                                >
                                    <ArrowUpOutlined style={{fontSize: 15}}/>
                                </button>
                            )}
                        </div>
                    </div>
                </div>
                {!centered && (
                    <div className={styles.composerHint}>Enter 发送，Shift + Enter 换行</div>
                )}
            </form>
        </div>
    );

    return (
        <div className={styles.container}>
            {isEmptyConversation ? (
                <div className={styles.welcomeStage}>
                    <div className={styles.welcome}>
                        <div className={styles.welcomeBadge}>
                            <span className={styles.hubMetricDot} aria-hidden="true"/>
                            <span>
                                中枢已连接 · <strong>{onlineDeviceCount}</strong>/{devices.length} 设备在线
                                {graphs.length > 0 ? ` · ${enabledGraphCount} 条规则运行中` : ''}
                            </span>
                        </div>

                        <h1 className={styles.welcomeTitle}>你好，想搭建什么自动化？</h1>

                        {renderComposer(true)}

                        <div className={styles.starterChips}>
                            {STARTER_PROMPTS.map(item => {
                                const toneClass =
                                    item.tone === 'warm'
                                        ? styles.starterIconWarm
                                        : item.tone === 'info'
                                            ? styles.starterIconInfo
                                            : styles.starterIconSignal;
                                const Icon =
                                    item.tone === 'warm'
                                        ? BulbOutlined
                                        : item.tone === 'info'
                                            ? ApartmentOutlined
                                            : ThunderboltOutlined;
                                return (
                                    <button
                                        key={item.key}
                                        type="button"
                                        className={styles.starterChip}
                                        onClick={() => sendMessage(item.prompt)}
                                    >
                                        <span className={`${styles.starterChipIcon} ${toneClass}`} aria-hidden="true">
                                            <Icon style={{fontSize: 13}}/>
                                        </span>
                                        <span>{item.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    <div className={styles.messagesWrap}>
                        <div
                            ref={messagesContainerRef}
                            className={styles.messages}
                            onScroll={handleMessagesScroll}
                        >
                            <div className={styles.messagesInner}>
                                {messages.map(msg =>
                                    msg.role === 'user' ? (
                                        <div key={msg.id} className={styles.userRow}>
                                            <div className={styles.userBlock}>
                                                <div className={styles.userBubble}>{msg.content}</div>
                                                {currentSessionId && onResetSession && !isLoading && msg.seq !== undefined && (
                                                    <button
                                                        type="button"
                                                        className={styles.resetAction}
                                                        onClick={() => handleReset(msg.seq!, msg.content)}
                                                    >
                                                        <RollbackOutlined style={{fontSize: 12}}/>
                                                        <span>回退重做</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        renderAssistantMessage(msg)
                                    )
                                )}

                                {renderStreaming()}

                                {waitingInput && Array.isArray(waitingInput.options) && waitingInput.options.length > 0 && (
                                    <div className={styles.optionCard}>
                                        <p className={styles.optionTitle}>需要你的确认</p>
                                        {waitingInput.question && (
                                            <div className={`${styles.optionQuestion} markdown-content`}>
                                                {renderMarkdown(waitingInput.question)}
                                            </div>
                                        )}
                                        <div className={styles.optionList}>
                                            {waitingInput.options.map((opt, i) => (
                                                <button
                                                    key={`option-${i}`}
                                                    type="button"
                                                    className={styles.optionButton}
                                                    onClick={() => {
                                                        setWaitingInput(null);
                                                        sendMessage(opt);
                                                    }}
                                                >
                                                    {opt}
                                                </button>
                                            ))}
                                        </div>
                                        <div className={styles.optionHint}>也可以在下方直接输入自定义回复。</div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {showScrollBottom && (
                            <button
                                type="button"
                                className={styles.scrollBottomButton}
                                onClick={scrollToBottom}
                            >
                                <DownOutlined style={{fontSize: 11}}/>
                                <span>回到底部</span>
                            </button>
                        )}
                    </div>

                    {renderComposer(false)}
                </>
            )}
        </div>
    );
}
