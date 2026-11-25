'use client';

import React, {useState, useRef, useEffect, useCallback, useMemo} from 'react';
import {message} from 'antd';
import {Bubble, Prompts, XStream} from '@ant-design/x';
import type {BubbleListProps, BubbleDataType} from '@ant-design/x/es/bubble/BubbleList';
import type {PromptProps} from '@ant-design/x';
import {
    ApartmentOutlined,
    BulbOutlined,
    CheckOutlined,
    CopyOutlined,
    DownOutlined,
    EditOutlined,
    ReloadOutlined,
    RollbackOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatProcessChain, {type ToolCallItem} from './ChatProcessChain';
import ChatComposer, {type MentionDevice, type MentionGraph} from './ChatComposer';
import styles from './Chat.module.css';

interface AgentOutput {
    type: 'session' | 'thinking' | 'tool_start' | 'tool_result' | 'complete' | 'waiting_input' | 'error';
    sessionId?: string;
    content?: string;
    tool?: string;
    args?: any;
    result?: any;
    question?: string;
    options?: string[];
    error?: string;
    message?: string;
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

const GRAPH_WRITE_TOOL_RE = /(create|update|patch|put|delete|toggle)_?graph/i;

const STARTER_PROMPTS: Array<PromptProps & { prompt: string }> = [
    {
        key: 'devices',
        icon: <BulbOutlined style={{color: 'var(--ui-warm)'}}/>,
        label: '查看设备状态',
        prompt: '帮我查看设备状态',
    },
    {
        key: 'create',
        icon: <ThunderboltOutlined style={{color: 'var(--ui-signal)'}}/>,
        label: '创建自动化规则',
        prompt: '帮我创建自动化规则',
    },
    {
        key: 'rules',
        icon: <ApartmentOutlined style={{color: 'var(--ui-info)'}}/>,
        label: '查看现有规则',
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

/**
 * 记忆化 Markdown 渲染组件，仅在 content 变化时重新解析 AST。
 */
const AssistantMarkdown = React.memo(function AssistantMarkdown({content}: { content: string }) {
    if (!content) return null;
    return (
        <div className={`${styles.assistantProse} markdown-content`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {content}
            </ReactMarkdown>
        </div>
    );
});

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
    const [isLoading, setIsLoading] = useState(false);
    const [waitingInput, setWaitingInput] = useState<{ question: string; options: string[] } | null>(null);
    const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(sessionId);
    const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const [resetDraft, setResetDraft] = useState<{ text: string; seq: number } | null>(null);
    const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');

    const [streamThinking, setStreamThinking] = useState('');
    const [streamToolCalls, setStreamToolCalls] = useState<ToolCallItem[]>([]);
    const [streamFinalContent, setStreamFinalContent] = useState('');

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const isNearBottomRef = useRef(true);
    const abortControllerRef = useRef<AbortController | null>(null);
    const rafIdRef = useRef<number | null>(null);
    const draftSeqRef = useRef(0);
    const passcode = propPasscode || '';
    const prevSessionIdRef = useRef<string | undefined>(sessionId);
    const prevInitialMessagesRef = useRef<SessionMessage[] | undefined>(undefined);
    const skipInitialSyncRef = useRef(false);

    const cancelPendingRaf = useCallback(() => {
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => cancelPendingRaf();
    }, [cancelPendingRaf]);

    useEffect(() => {
        if (sessionId !== prevSessionIdRef.current) {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
            }
            cancelPendingRaf();
            setStreamThinking('');
            setStreamToolCalls([]);
            setStreamFinalContent('');
            setWaitingInput(null);
            setIsLoading(false);
            setCurrentSessionId(sessionId);
            prevSessionIdRef.current = sessionId;
            prevInitialMessagesRef.current = undefined;
        }
    }, [sessionId, cancelPendingRaf]);

    useEffect(() => {
        if (initialMessages === prevInitialMessagesRef.current) return;
        prevInitialMessagesRef.current = initialMessages;

        if (skipInitialSyncRef.current) {
            skipInitialSyncRef.current = false;
            return;
        }
        if (isLoading) return;

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

            // 若会话最后一条是未回复的 ask_user 工具调用，恢复待确认选项卡片
            const lastVisible = visibleMessages[visibleMessages.length - 1];
            const askUserCall = lastVisible?.role === 'assistant'
                ? [...(lastVisible.toolCalls || [])].reverse().find(tc => tc.tool === 'ask_user')
                : undefined;
            const askArgs = askUserCall?.args as { question?: string; options?: unknown } | undefined;
            const askOptions = Array.isArray(askArgs?.options)
                ? askArgs.options.filter((opt): opt is string => typeof opt === 'string' && opt.length > 0)
                : [];
            if (askUserCall && (askOptions.length > 0 || askArgs?.question)) {
                setWaitingInput({
                    question: askArgs?.question || '请选择',
                    options: askOptions,
                });
            } else {
                setWaitingInput(null);
            }
        } else if (initialMessages && initialMessages.length === 0) {
            setMessages([]);
            setWaitingInput(null);
        }
    }, [initialMessages, isLoading]);

    // 仅在用户接近底部时自动跟随滚动，避免向上翻看长消息时被抢滚动条
    useEffect(() => {
        const el = messagesContainerRef.current;
        if (!el || !isNearBottomRef.current) return;
        el.scrollTop = el.scrollHeight;
    }, [messages, streamThinking, streamToolCalls, streamFinalContent, waitingInput]);

    const handleMessagesScroll = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nearBottom = distanceToBottom < 80;
        isNearBottomRef.current = nearBottom;
        const nextShow = !nearBottom && el.scrollHeight > el.clientHeight + 120;
        setShowScrollBottom(prev => (prev === nextShow ? prev : nextShow));
    }, []);

    const scrollToBottom = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        isNearBottomRef.current = true;
        setShowScrollBottom(false);
        el.scrollTo({top: el.scrollHeight, behavior: 'smooth'});
    }, []);

    const handleCopyMessage = useCallback(async (msgId: string, content: string) => {
        try {
            await navigator.clipboard.writeText(content);
            setCopiedMsgId(msgId);
            setTimeout(() => {
                setCopiedMsgId(prev => (prev === msgId ? null : prev));
            }, 1600);
        } catch {
            // 忽略剪贴板权限受限
        }
    }, []);

    const handleStop = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        cancelPendingRaf();
        setIsLoading(false);
        setStreamThinking('');
        setStreamToolCalls([]);
        setStreamFinalContent('');
        setWaitingInput(null);
    }, [cancelPendingRaf]);

    const handleReset = useCallback(async (targetSeq: number, messageContent: string) => {
        if (!currentSessionId || !onResetSession) return;
        handleStop();
        try {
            await onResetSession(currentSessionId, targetSeq - 1);
            setResetDraft({text: messageContent, seq: ++draftSeqRef.current});
        } catch {
            // 错误提示已在外层处理
        }
    }, [currentSessionId, onResetSession, handleStop]);

    const sendMessage = useCallback(async (messageText: string) => {
        if (!messageText.trim() || isLoading) return;

        const userMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'user',
            content: messageText,
        };
        setMessages(prev => {
            const nextSeq = prev.length === 0 ? 0 : (prev[prev.length - 1].seq ?? prev.length - 1) + 1;
            return [...prev, {...userMessage, seq: nextSeq}];
        });
        setIsLoading(true);
        setWaitingInput(null);
        isNearBottomRef.current = true;
        setShowScrollBottom(false);

        let currentThinking = '';
        const currentToolCalls: ToolCallItem[] = [];
        let finalContent = '';
        let resolvedSessionId = currentSessionId;
        setStreamThinking('');
        setStreamToolCalls([]);
        setStreamFinalContent('');

        const flushThinking = () => {
            rafIdRef.current = null;
            setStreamThinking(currentThinking);
        };

        const scheduleThinkingFlush = () => {
            if (rafIdRef.current === null) {
                rafIdRef.current = requestAnimationFrame(flushThinking);
            }
        };

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({message: messageText, passcode, sessionId: currentSessionId}),
                signal: abortController.signal,
            });

            if (!response.ok) {
                let errorDetail = `HTTP error! status: ${response.status}`;
                try {
                    const errBody = await response.json();
                    if (errBody?.error) errorDetail = errBody.error;
                } catch {
                    // ignore non-json error body
                }
                throw new Error(errorDetail);
            }
            if (!response.body) throw new Error('无法读取响应流');

            // 使用 @ant-design/x XStream 完整解析跨 chunk 的 SSE 事件
            for await (const sse of XStream({readableStream: response.body})) {
                if (abortController.signal.aborted) break;
                const rawData = typeof sse.data === 'string' ? sse.data.trim() : '';
                if (!rawData || rawData === '[DONE]') continue;

                try {
                    const output: AgentOutput = JSON.parse(rawData);
                    switch (output.type) {
                        case 'session':
                            if (output.sessionId) {
                                resolvedSessionId = output.sessionId;
                                setCurrentSessionId(output.sessionId);
                            }
                            break;
                        case 'thinking':
                            currentThinking += output.content || '';
                            scheduleThinkingFlush();
                            break;
                        case 'tool_start':
                            cancelPendingRaf();
                            setStreamThinking(currentThinking);
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
                            cancelPendingRaf();
                            setStreamThinking(currentThinking);
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
                    if (rawData.length > 2) {
                        console.warn('流式数据解析失败:', rawData, parseError);
                    }
                }
            }

            cancelPendingRaf();
            if (abortController.signal.aborted) return;

            if (!currentSessionId && resolvedSessionId) {
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
                skipInitialSyncRef.current = true;
                onSessionCreated?.(resolvedSessionId, [userSessionMessage, assistantSessionMessage]);
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
            setMessages(prev => {
                const nextSeq = prev.length === 0 ? 1 : (prev[prev.length - 1].seq ?? prev.length - 1) + 1;
                return [...prev, {...assistantMessage, seq: nextSeq}];
            });
            setStreamThinking('');
            setStreamToolCalls([]);
            setStreamFinalContent('');

            if (currentToolCalls.some(tc => tc.success && GRAPH_WRITE_TOOL_RE.test(tc.tool))) {
                onGraphsMutated?.();
            }
        } catch (error: any) {
            cancelPendingRaf();
            if (error.name === 'AbortError') return;
            setResetDraft({text: messageText, seq: ++draftSeqRef.current});
            setMessages(prev => prev.filter(m => m.id !== userMessage.id));
            message.error('发送失败: ' + error.message);
        } finally {
            abortControllerRef.current = null;
            setIsLoading(false);
        }
    }, [isLoading, passcode, currentSessionId, onSessionCreated, onGraphsMutated, cancelPendingRaf]);

    const handleRegenerate = useCallback(async (assistantIndex: number) => {
        if (isLoading || !currentSessionId || !onResetSession) return;
        let userMsg: ChatMessage | undefined;
        for (let i = assistantIndex - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                userMsg = messages[i];
                break;
            }
        }
        if (!userMsg || userMsg.seq === undefined) return;
        try {
            skipInitialSyncRef.current = true;
            await onResetSession(currentSessionId, userMsg.seq - 1);
            setMessages(prev => prev.filter(m => (m.seq ?? 0) < userMsg!.seq!));
            await sendMessage(userMsg.content);
        } catch {
            skipInitialSyncRef.current = false;
        }
    }, [isLoading, currentSessionId, onResetSession, messages, sendMessage]);

    const handleSubmitEdit = useCallback(async (msg: ChatMessage) => {
        const trimmed = editingText.trim();
        if (!trimmed || isLoading) return;
        if (trimmed === msg.content.trim()) {
            setEditingMsgId(null);
            setEditingText('');
            return;
        }
        if (!currentSessionId || !onResetSession || msg.seq === undefined) return;
        setEditingMsgId(null);
        setEditingText('');
        try {
            skipInitialSyncRef.current = true;
            await onResetSession(currentSessionId, msg.seq - 1);
            setMessages(prev => prev.filter(m => (m.seq ?? 0) < msg.seq!));
            await sendMessage(trimmed);
        } catch {
            skipInitialSyncRef.current = false;
        }
    }, [editingText, isLoading, currentSessionId, onResetSession, sendMessage]);

    const roles = useMemo<BubbleListProps['roles']>(() => ({
        user: {
            placement: 'end',
            variant: 'filled',
            shape: 'corner',
            styles: {
                content: {
                    background: 'var(--ui-signal)',
                    color: 'var(--ui-btn-primary-text)',
                    maxWidth: 560,
                },
            },
        },
        assistant: {
            placement: 'start',
            variant: 'borderless',
            avatar: <AssistantMark/>,
            styles: {
                content: {
                    padding: 0,
                    maxWidth: '100%',
                    width: '100%',
                },
            },
        },
    }), []);

    // 历史消息列表与流式态分离，确保流式输出不触发历史消息重算
    const historyBubbleItems = useMemo<BubbleDataType[]>(() => {
        return messages.map((msg, msgIndex) => {
            if (msg.role === 'user') {
                const isCopied = copiedMsgId === msg.id;
                const isEditing = editingMsgId === msg.id;
                const canMutateHistory = Boolean(currentSessionId && onResetSession && !isLoading && msg.seq !== undefined);

                return {
                    key: msg.id,
                    role: 'user',
                    content: isEditing ? (
                        <div className={styles.editBox}>
                            <textarea
                                className={styles.editTextarea}
                                rows={3}
                                autoFocus
                                value={editingText}
                                onChange={(e) => setEditingText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setEditingMsgId(null);
                                        setEditingText('');
                                    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        handleSubmitEdit(msg);
                                    }
                                }}
                                aria-label="编辑消息内容"
                            />
                            <div className={styles.editActions}>
                                <button
                                    type="button"
                                    className={styles.editCancelBtn}
                                    onClick={() => {
                                        setEditingMsgId(null);
                                        setEditingText('');
                                    }}
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    className={styles.editSaveBtn}
                                    disabled={!editingText.trim()}
                                    onClick={() => handleSubmitEdit(msg)}
                                >
                                    保存并重发
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.userBubbleContent}>{msg.content}</div>
                    ),
                    footer: !isEditing ? (
                        <div className={styles.userFooter}>
                            <button
                                type="button"
                                className={`${styles.copyAction} ${isCopied ? styles.copyActionCopied : ''}`}
                                onClick={() => handleCopyMessage(msg.id, msg.content)}
                            >
                                {isCopied ? <CheckOutlined style={{fontSize: 12}}/> : <CopyOutlined style={{fontSize: 12}}/>}
                                <span>{isCopied ? '已复制' : '复制'}</span>
                            </button>
                            {canMutateHistory && (
                                <>
                                    <button
                                        type="button"
                                        className={styles.resetAction}
                                        onClick={() => {
                                            setEditingMsgId(msg.id);
                                            setEditingText(msg.content);
                                        }}
                                    >
                                        <EditOutlined style={{fontSize: 12}}/>
                                        <span>编辑</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.resetAction}
                                        onClick={() => handleReset(msg.seq!, msg.content)}
                                    >
                                        <RollbackOutlined style={{fontSize: 12}}/>
                                        <span>回退重做</span>
                                    </button>
                                </>
                            )}
                        </div>
                    ) : undefined,
                };
            }

            const toolCalls = msg.process?.toolCalls || [];
            const thinking = msg.process?.thinking || '';
            const hasProcess = Boolean(thinking || toolCalls.length > 0);
            const isCopied = copiedMsgId === msg.id;
            const hasPrevUser = msgIndex > 0 && messages.slice(0, msgIndex).some(m => m.role === 'user' && m.seq !== undefined);
            const canRegenerate = Boolean(currentSessionId && onResetSession && !isLoading && hasPrevUser);

            return {
                key: msg.id,
                role: 'assistant',
                content: (
                    <div className={styles.assistantStack}>
                        {hasProcess && (
                            <ChatProcessChain
                                idPrefix={msg.id}
                                thinking={thinking}
                                toolCalls={toolCalls}
                                streaming={false}
                            />
                        )}
                        <AssistantMarkdown content={msg.content}/>
                    </div>
                ),
                footer: msg.content || canRegenerate ? (
                    <div className={styles.msgActions}>
                        {msg.content && (
                            <button
                                type="button"
                                className={`${styles.copyAction} ${isCopied ? styles.copyActionCopied : ''}`}
                                onClick={() => handleCopyMessage(msg.id, msg.content)}
                            >
                                {isCopied ? <CheckOutlined style={{fontSize: 12}}/> : <CopyOutlined style={{fontSize: 12}}/>}
                                <span>{isCopied ? '已复制' : '复制'}</span>
                            </button>
                        )}
                        {canRegenerate && (
                            <button
                                type="button"
                                className={styles.resetAction}
                                onClick={() => handleRegenerate(msgIndex)}
                            >
                                <ReloadOutlined style={{fontSize: 12}}/>
                                <span>重新生成</span>
                            </button>
                        )}
                    </div>
                ) : undefined,
            };
        });
    }, [
        messages,
        currentSessionId,
        onResetSession,
        isLoading,
        copiedMsgId,
        editingMsgId,
        editingText,
        handleReset,
        handleCopyMessage,
        handleRegenerate,
        handleSubmitEdit,
    ]);

    const streamingBubbleItem = useMemo<BubbleDataType | null>(() => {
        if (!isLoading) return null;
        const hasContent = Boolean(streamThinking || streamToolCalls.length > 0 || streamFinalContent);

        return {
            key: '__streaming__',
            role: 'assistant',
            loading: !hasContent,
            loadingRender: () => (
                <div className={styles.typingDots} aria-label="助手正在思考">
                    <span/><span/><span/>
                </div>
            ),
            content: hasContent ? (
                <div className={styles.assistantStack}>
                    {(streamThinking || streamToolCalls.length > 0) && (
                        <ChatProcessChain
                            idPrefix="stream"
                            thinking={streamThinking}
                            toolCalls={streamToolCalls}
                            streaming={true}
                            hasFinalContent={Boolean(streamFinalContent)}
                        />
                    )}
                    <AssistantMarkdown content={streamFinalContent}/>
                </div>
            ) : undefined,
        };
    }, [isLoading, streamThinking, streamToolCalls, streamFinalContent]);

    const bubbleItems = useMemo<BubbleDataType[]>(() => {
        return streamingBubbleItem
            ? [...historyBubbleItems, streamingBubbleItem]
            : historyBubbleItems;
    }, [historyBubbleItems, streamingBubbleItem]);

    const isEmptyConversation = messages.length === 0 && !isLoading;

    return (
        <div className={styles.container}>
            {isEmptyConversation ? (
                <div className={styles.welcomeStage}>
                    <div className={styles.welcome}>
                        <h1 className={styles.welcomeTitle}>你好，想搭建什么自动化？</h1>

                        <ChatComposer
                            sessionKey={currentSessionId || '__new__'}
                            centered={true}
                            isLoading={isLoading}
                            hasWaitingInput={Boolean(waitingInput)}
                            draftInsert={draftInsert}
                            resetDraft={resetDraft}
                            devices={devices}
                            graphs={graphs}
                            graphsLoading={graphsLoading}
                            onEnsureGraphsLoaded={onEnsureGraphsLoaded}
                            onSend={sendMessage}
                            onStop={handleStop}
                        />

                        <Prompts
                            className={styles.promptsWrap}
                            wrap
                            styles={{
                                list: {justifyContent: 'center', gap: 8},
                                item: {
                                    padding: '6px 12px',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--ui-subtle)',
                                    border: '1px solid var(--ui-border)',
                                    fontSize: 12.5,
                                },
                            }}
                            items={STARTER_PROMPTS}
                            onItemClick={(info) => {
                                const item = info.data as PromptProps & { prompt?: string };
                                if (item.prompt) sendMessage(item.prompt);
                            }}
                        />
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
                                <Bubble.List
                                    className={styles.bubbleList}
                                    autoScroll={false}
                                    roles={roles}
                                    items={bubbleItems}
                                />

                                {waitingInput && Array.isArray(waitingInput.options) && waitingInput.options.length > 0 && (
                                    <div className={styles.optionCard}>
                                        <div className={styles.optionHeader}>
                                            <p className={styles.optionTitle}>需要你的确认</p>
                                            {waitingInput.question && (
                                                <button
                                                    type="button"
                                                    className={`${styles.copyAction} ${
                                                        copiedMsgId === '__waiting_input__' ? styles.copyActionCopied : ''
                                                    }`}
                                                    onClick={() => handleCopyMessage('__waiting_input__', waitingInput.question)}
                                                >
                                                    {copiedMsgId === '__waiting_input__' ? (
                                                        <CheckOutlined style={{fontSize: 12}}/>
                                                    ) : (
                                                        <CopyOutlined style={{fontSize: 12}}/>
                                                    )}
                                                    <span>{copiedMsgId === '__waiting_input__' ? '已复制' : '复制'}</span>
                                                </button>
                                            )}
                                        </div>
                                        {waitingInput.question && (
                                            <AssistantMarkdown content={waitingInput.question}/>
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

                    <ChatComposer
                        sessionKey={currentSessionId || '__new__'}
                        centered={false}
                        isLoading={isLoading}
                        hasWaitingInput={Boolean(waitingInput)}
                        draftInsert={draftInsert}
                        resetDraft={resetDraft}
                        devices={devices}
                        graphs={graphs}
                        graphsLoading={graphsLoading}
                        onEnsureGraphsLoaded={onEnsureGraphsLoaded}
                        onSend={sendMessage}
                        onStop={handleStop}
                    />
                </>
            )}
        </div>
    );
}
