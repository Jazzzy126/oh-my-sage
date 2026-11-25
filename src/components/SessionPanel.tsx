'use client';

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CloseOutlined, DeleteOutlined, PlusOutlined, SearchOutlined, SyncOutlined} from '@ant-design/icons';
import ConfirmModal from './ConfirmModal';
import styles from './SessionPanel.module.css';

interface SessionMeta {
    id: string;
    title: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    isActive: boolean;
}

interface SessionPanelProps {
    sessions: SessionMeta[];
    activeSessionId?: string;
    loading?: boolean;
    embedded?: boolean;
    searchOpen?: boolean;
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onNewSession: () => void;
    onRefresh: () => void;
}

type TimeBucket = 'today' | 'yesterday' | 'earlier';

const BUCKET_LABELS: Record<TimeBucket, string> = {
    today: '今天',
    yesterday: '昨天',
    earlier: '更早',
};

function getTimeBucket(isoString: string, now: Date): TimeBucket {
    const date = new Date(isoString);
    if (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
    ) {
        return 'today';
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (
        date.getFullYear() === yesterday.getFullYear() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getDate() === yesterday.getDate()
    ) {
        return 'yesterday';
    }
    return 'earlier';
}

function formatTime(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const bucket = getTimeBucket(isoString, now);
    if (bucket === 'today' || bucket === 'yesterday') {
        return date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
    }
    return date.toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'});
}

export default function SessionPanel({
    sessions,
    activeSessionId,
    loading = false,
    embedded = false,
    searchOpen = false,
    onSelectSession,
    onDeleteSession,
    onNewSession,
    onRefresh,
}: SessionPanelProps) {
    const [searchText, setSearchText] = useState('');
    const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (embedded && searchOpen) {
            requestAnimationFrame(() => searchInputRef.current?.focus());
        } else if (embedded && !searchOpen) {
            setSearchText('');
        }
    }, [embedded, searchOpen]);

    const filteredFlatSessions = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();
        if (!keyword) return sessions;
        return sessions.filter((session) => {
            const matchTitle = (session.title || '').toLowerCase().includes(keyword);
            const matchSummary = (session.summary || '').toLowerCase().includes(keyword);
            return matchTitle || matchSummary;
        });
    }, [sessions, searchText]);

    const groupedSessions = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();
        const now = new Date();
        const buckets: Record<TimeBucket, SessionMeta[]> = {
            today: [],
            yesterday: [],
            earlier: [],
        };
        for (const session of sessions) {
            if (keyword) {
                const matchTitle = (session.title || '').toLowerCase().includes(keyword);
                const matchSummary = (session.summary || '').toLowerCase().includes(keyword);
                if (!matchTitle && !matchSummary) continue;
            }
            const bucket = getTimeBucket(session.updatedAt, now);
            buckets[bucket].push(session);
        }
        return (['today', 'yesterday', 'earlier'] as TimeBucket[])
            .filter((key) => buckets[key].length > 0)
            .map((key) => ({
                key,
                label: BUCKET_LABELS[key],
                items: buckets[key],
            }));
    }, [sessions, searchText]);

    const showInitialLoading = loading && sessions.length === 0;
    const hasFilter = searchText.trim().length > 0;

    if (embedded) {
        return (
            <div className={`${styles.panel} ${styles.panelEmbedded}`} aria-label="对话历史">
                <div className={styles.compactHeader}>
                    <span className={styles.compactTitle}>全部</span>
                    <button
                        type="button"
                        className={styles.compactRefresh}
                        onClick={onRefresh}
                        disabled={loading}
                        aria-label="刷新对话历史"
                        title="刷新对话历史"
                    >
                        <SyncOutlined spin={loading} style={{fontSize: 12}}/>
                    </button>
                </div>

                {searchOpen && (
                    <div className={styles.compactSearchWrap}>
                        <div className={styles.searchBox}>
                            <span className={styles.searchIcon} aria-hidden="true">
                                <SearchOutlined style={{fontSize: 12}}/>
                            </span>
                            <input
                                ref={searchInputRef}
                                type="text"
                                className={styles.compactSearchInput}
                                placeholder="搜索对话…"
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                aria-label="搜索对话历史"
                            />
                            {searchText && (
                                <button
                                    type="button"
                                    className={styles.clearSearch}
                                    onClick={() => setSearchText('')}
                                    aria-label="清除搜索"
                                >
                                    <CloseOutlined style={{fontSize: 10}}/>
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <div className={styles.compactList}>
                    {showInitialLoading ? (
                        <div className={styles.compactSkeletonList} aria-label="正在加载对话历史">
                            {[0, 1, 2, 3].map((i) => (
                                <div key={i} className={styles.compactSkeletonRow}/>
                            ))}
                        </div>
                    ) : filteredFlatSessions.length === 0 ? (
                        <div className={styles.compactEmpty}>
                            {hasFilter ? '没有匹配的对话' : '暂无历史对话'}
                        </div>
                    ) : (
                        filteredFlatSessions.map((session) => {
                            const isActive = session.id === activeSessionId;
                            return (
                                <div
                                    key={session.id}
                                    className={`${styles.compactItem} ${isActive ? styles.compactItemActive : ''}`}
                                >
                                    <button
                                        type="button"
                                        className={styles.compactItemMain}
                                        aria-current={isActive ? 'page' : undefined}
                                        title={session.title || '未命名对话'}
                                        onClick={() => onSelectSession(session.id)}
                                    >
                                        <span className={styles.compactItemTitle}>
                                            {session.title || '未命名对话'}
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        className={styles.compactDelete}
                                        aria-label={`删除对话「${session.title || '未命名对话'}」`}
                                        title="删除对话"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setPendingDelete(session);
                                        }}
                                    >
                                        <DeleteOutlined style={{fontSize: 12}}/>
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>

                <ConfirmModal
                    open={pendingDelete !== null}
                    title={`删除对话「${pendingDelete?.title || '未命名对话'}」？`}
                    description="删除后无法恢复该对话的历史消息。"
                    confirmText="删除"
                    cancelText="取消"
                    danger
                    onCancel={() => setPendingDelete(null)}
                    onConfirm={async () => {
                        if (!pendingDelete) return;
                        await onDeleteSession(pendingDelete.id);
                        setPendingDelete(null);
                    }}
                />
            </div>
        );
    }

    return (
        <div className={styles.panel} aria-label="对话历史">
            <div className={styles.header}>
                <div className={styles.headerTop}>
                    <div className={styles.titleGroup}>
                        <h2 className={styles.title}>对话历史</h2>
                        {sessions.length > 0 && (
                            <span className={styles.count} aria-label={`共 ${sessions.length} 条对话`}>
                                {sessions.length}
                            </span>
                        )}
                    </div>

                    <div className={styles.headerActions}>
                        <button
                            type="button"
                            className={styles.newButton}
                            onClick={onNewSession}
                        >
                            <PlusOutlined style={{fontSize: 12}}/>
                            <span>新对话</span>
                        </button>

                        <button
                            type="button"
                            className={styles.refreshButton}
                            onClick={onRefresh}
                            disabled={loading}
                            aria-label="刷新对话历史"
                            title="刷新对话历史"
                        >
                            <SyncOutlined spin={loading} style={{fontSize: 13}}/>
                        </button>
                    </div>
                </div>

                <div className={styles.searchBox}>
                    <span className={styles.searchIcon} aria-hidden="true">
                        <SearchOutlined style={{fontSize: 13}}/>
                    </span>
                    <input
                        type="text"
                        className={styles.searchInput}
                        placeholder="搜索对话标题或摘要"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        aria-label="搜索对话历史"
                    />
                    {searchText && (
                        <button
                            type="button"
                            className={styles.clearSearch}
                            onClick={() => setSearchText('')}
                            aria-label="清除搜索"
                        >
                            <CloseOutlined style={{fontSize: 11}}/>
                        </button>
                    )}
                </div>
            </div>

            <div className={styles.list}>
                {showInitialLoading ? (
                    <div className={styles.skeletonList} aria-label="正在加载对话历史">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className={styles.skeletonCard}>
                                <div className={styles.skeletonLine}/>
                                <div className={styles.skeletonLineShort}/>
                            </div>
                        ))}
                    </div>
                ) : groupedSessions.length === 0 ? (
                    <div className={styles.emptyState}>
                        <p className={styles.emptyTitle}>
                            {hasFilter ? '没有匹配的对话' : '还没有对话记录'}
                        </p>
                        <p className={styles.emptyDesc}>
                            {hasFilter
                                ? '尝试更换搜索关键词。'
                                : '描述你想搭建或调整的米家自动化场景，历史对话会自动保存在这里。'}
                        </p>
                        <button
                            type="button"
                            className={styles.emptyAction}
                            onClick={hasFilter ? () => setSearchText('') : onNewSession}
                        >
                            {hasFilter ? '清除搜索' : '开始新对话'}
                        </button>
                    </div>
                ) : (
                    groupedSessions.map((group) => (
                        <section key={group.key} className={styles.group} aria-label={group.label}>
                            <div className={styles.groupHeader}>
                                <span>{group.label}</span>
                                <span className={styles.groupCount}>{group.items.length}</span>
                            </div>

                            <div className={styles.groupItems}>
                                {group.items.map((session) => {
                                    const isActive = session.id === activeSessionId;

                                    return (
                                        <div
                                            key={session.id}
                                            className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                                        >
                                            <button
                                                type="button"
                                                className={styles.itemMain}
                                                aria-current={isActive ? 'page' : undefined}
                                                onClick={() => onSelectSession(session.id)}
                                            >
                                                <div className={styles.itemTopRow}>
                                                    <span className={styles.itemTitle}>
                                                        {session.title || '未命名对话'}
                                                    </span>
                                                    <span className={styles.itemTime}>
                                                        {formatTime(session.updatedAt)}
                                                    </span>
                                                </div>
                                                {session.summary && (
                                                    <span className={styles.itemSummary}>
                                                        {session.summary}
                                                    </span>
                                                )}
                                            </button>

                                            <div className={styles.itemFooter}>
                                                <span className={styles.itemCount}>
                                                    {session.messageCount} 条消息
                                                </span>

                                                <button
                                                    type="button"
                                                    className={styles.deleteTrigger}
                                                    aria-label={`删除对话「${session.title || '未命名对话'}」`}
                                                    title="删除对话"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setPendingDelete(session);
                                                    }}
                                                >
                                                    <DeleteOutlined style={{fontSize: 12}}/>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    ))
                )}
            </div>

            <ConfirmModal
                open={pendingDelete !== null}
                title={`删除对话「${pendingDelete?.title || '未命名对话'}」？`}
                description="删除后无法恢复该对话的历史消息。"
                confirmText="删除"
                cancelText="取消"
                danger
                onCancel={() => setPendingDelete(null)}
                onConfirm={async () => {
                    if (!pendingDelete) return;
                    await onDeleteSession(pendingDelete.id);
                    setPendingDelete(null);
                }}
            />
        </div>
    );
}
