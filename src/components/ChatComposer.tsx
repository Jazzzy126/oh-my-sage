'use client';

import React, {useState, useRef, useEffect, useCallback, useMemo} from 'react';
import {Sender} from '@ant-design/x';
import type {SenderRef} from '@ant-design/x/es/sender';
import {
    ApartmentOutlined,
    AppstoreOutlined,
    SearchOutlined,
} from '@ant-design/icons';
import styles from './Chat.module.css';

export interface MentionDevice {
    did: string;
    name: string;
    model?: string;
    online: boolean;
    roomName?: string;
}

export interface MentionGraph {
    id: string;
    name: string;
    enable: boolean;
    rooms?: string[];
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

interface ChatComposerProps {
    sessionKey: string;
    centered: boolean;
    isLoading: boolean;
    hasWaitingInput: boolean;
    draftInsert?: { text: string; seq: number } | null;
    resetDraft?: { text: string; seq: number } | null;
    devices: MentionDevice[];
    graphs: MentionGraph[];
    graphsLoading: boolean;
    onEnsureGraphsLoaded?: () => void;
    onSend: (text: string) => void;
    onStop: () => void;
}

const DRAFT_STORAGE_PREFIX = 'oh-my-sage-draft:';

const MENTION_TRIGGER_RE = /(?:^|[\s，。！？、；：（(\[])(@([^\s@]*))$/;

/**
 * 独立封装输入区与 @ 引用弹窗（基于 @ant-design/x Sender）。
 * 将 input 与弹窗筛选状态隔离在子组件内部，避免打字与检索触发历史消息列表重渲染。
 */
const ChatComposer = React.memo(function ChatComposer({
    sessionKey,
    centered,
    isLoading,
    hasWaitingInput,
    draftInsert,
    resetDraft,
    devices,
    graphs,
    graphsLoading,
    onEnsureGraphsLoaded,
    onSend,
    onStop,
}: ChatComposerProps) {
    const [input, setInput] = useState('');
    const [mentionMode, setMentionMode] = useState<'closed' | 'button' | 'inline'>('closed');
    const [mentionTab, setMentionTab] = useState<MentionTab>('all');
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);

    const senderRef = useRef<SenderRef>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const mentionSearchRef = useRef<HTMLInputElement>(null);
    const mentionListRef = useRef<HTMLDivElement>(null);
    const savedCursorRef = useRef<number | null>(null);
    const prevSessionKeyRef = useRef<string>(sessionKey);

    // 切换会话或首次挂载时从 sessionStorage 恢复草稿
    useEffect(() => {
        try {
            const saved = window.sessionStorage.getItem(`${DRAFT_STORAGE_PREFIX}${sessionKey}`) || '';
            setInput(saved);
        } catch {
            if (prevSessionKeyRef.current !== sessionKey) {
                setInput('');
            }
        }
        prevSessionKeyRef.current = sessionKey;
    }, [sessionKey]);

    // 草稿自动写入 sessionStorage
    useEffect(() => {
        try {
            const key = `${DRAFT_STORAGE_PREFIX}${sessionKey}`;
            if (input) {
                window.sessionStorage.setItem(key, input);
            } else {
                window.sessionStorage.removeItem(key);
            }
        } catch {
            // 忽略隐私模式限制
        }
    }, [sessionKey, input]);

    const getTextareaEl = useCallback((): HTMLTextAreaElement | null => {
        return senderRef.current?.nativeElement?.querySelector('textarea') ?? null;
    }, []);

    // 接收来自设备/规则面板的快捷引用文本并聚焦输入框
    useEffect(() => {
        if (!draftInsert?.text) return;
        setInput(prev => {
            if (!prev.trim()) return draftInsert.text;
            const sep = prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' ';
            return `${prev}${sep}${draftInsert.text}`;
        });
        requestAnimationFrame(() => {
            const el = getTextareaEl();
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
            }
        });
    }, [draftInsert, getTextareaEl]);

    // 回退重做或发送失败时恢复输入文本
    useEffect(() => {
        if (!resetDraft?.text) return;
        setInput(resetDraft.text);
        requestAnimationFrame(() => {
            const el = getTextareaEl();
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
            }
        });
    }, [resetDraft, getTextareaEl]);

    const mentionOpen = mentionMode !== 'closed';

    const closeMention = useCallback(() => {
        setMentionMode('closed');
        setMentionQuery('');
        setMentionRange(null);
        setMentionIndex(0);
    }, []);

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

    useEffect(() => {
        if (mentionMode === 'button') {
            requestAnimationFrame(() => mentionSearchRef.current?.focus());
        }
    }, [mentionMode]);

    const mentionOptions = useMemo<MentionOption[]>(() => {
        if (!mentionOpen) return [];
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
                const roomLabel = g.rooms && g.rooms.length > 0 ? g.rooms.join('、') : '';
                if (
                    kw &&
                    !g.name.toLowerCase().includes(kw) &&
                    !g.id.toLowerCase().includes(kw) &&
                    !roomLabel.toLowerCase().includes(kw)
                ) {
                    continue;
                }
                items.push({
                    key: `graph:${g.id}`,
                    kind: 'graph',
                    title: g.name,
                    meta: `${roomLabel ? `${roomLabel} · ` : '自动化规则 · '}${g.enable ? '已启用' : '已停用'}`,
                    active: g.enable,
                    insertText: `「${g.name}」（规则 ID: ${g.id}）`,
                });
            }
        }

        return items;
    }, [mentionOpen, devices, graphs, mentionQuery, mentionTab]);

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
            const el = getTextareaEl();
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = nextCursor;
            }
        });
    }, [mentionMode, mentionRange, closeMention, getTextareaEl]);

    const handleToggleMentionButton = useCallback(() => {
        if (mentionMode === 'button') {
            closeMention();
            senderRef.current?.focus();
            return;
        }
        const el = getTextareaEl();
        savedCursorRef.current = el?.selectionStart ?? input.length;
        setMentionTab('all');
        setMentionQuery('');
        setMentionRange(null);
        setMentionMode('button');
        onEnsureGraphsLoaded?.();
    }, [mentionMode, closeMention, getTextareaEl, input.length, onEnsureGraphsLoaded]);

    const handleInputChange = useCallback((
        value: string,
        event?: React.FormEvent<HTMLTextAreaElement> | React.ChangeEvent<HTMLTextAreaElement>
    ) => {
        setInput(value);
        const target = event?.currentTarget;
        const cursor = target?.selectionStart ?? value.length;
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
    }, [mentionMode, closeMention, onEnsureGraphsLoaded]);

    const handleMentionNavigationKey = useCallback((e: React.KeyboardEvent): boolean => {
        if (!mentionOpen) return false;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMention();
            senderRef.current?.focus();
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
    }, [mentionOpen, closeMention, mentionOptions, mentionIndex, handleSelectMention]);

    const handleSenderKeyDown = useCallback((e: React.KeyboardEvent<any>) => {
        if (mentionMode === 'inline') {
            handleMentionNavigationKey(e);
        }
    }, [mentionMode, handleMentionNavigationKey]);

    const handleSubmit = useCallback((messageText: string) => {
        if (mentionMode === 'inline') return;
        const trimmed = messageText.trim();
        if (!trimmed || isLoading) return;
        setInput('');
        closeMention();
        onSend(messageText);
    }, [mentionMode, isLoading, closeMention, onSend]);

    return (
        <div className={centered ? styles.composerCentered : styles.composerWrap}>
            <div className={styles.composerForm}>
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

                    <Sender
                        ref={senderRef}
                        className={styles.senderBox}
                        value={input}
                        loading={isLoading}
                        disabled={isLoading && !hasWaitingInput}
                        submitType="enter"
                        autoSize={{minRows: 1, maxRows: 5}}
                        placeholder={
                            hasWaitingInput
                                ? '选择上方选项，或输入自定义回复'
                                : '问问智者，或输入 @ 引用设备与自动化规则'
                        }
                        onChange={handleInputChange}
                        onKeyDown={handleSenderKeyDown}
                        onSubmit={handleSubmit}
                        onCancel={onStop}
                        prefix={
                            <button
                                type="button"
                                className={`${styles.mentionTrigger} ${
                                    mentionOpen ? styles.mentionTriggerActive : ''
                                }`}
                                onClick={handleToggleMentionButton}
                                disabled={isLoading && !hasWaitingInput}
                                aria-haspopup="dialog"
                                aria-expanded={mentionOpen}
                                aria-label="引用设备或自动化规则"
                                title="引用设备或自动化规则 (@)"
                            >
                                <span className={styles.mentionAt}>@</span>
                                <span>引用</span>
                            </button>
                        }
                    />
                </div>
                {!centered && (
                    <div className={styles.composerHint}>Enter 发送，Shift + Enter 换行</div>
                )}
            </div>
        </div>
    );
});

export default ChatComposer;
