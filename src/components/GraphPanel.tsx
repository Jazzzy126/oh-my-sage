'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {createPortal} from 'react-dom';
import {CloseOutlined, DeleteOutlined, EditOutlined, SearchOutlined, SyncOutlined} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ConfirmModal from './ConfirmModal';
import styles from './GraphPanel.module.css';

interface GraphSummary {
    id: string;
    name: string;
    enable: boolean;
    lastUpdateTime?: number;
}

interface RuleNodeItem {
    id: string;
    type: string;
    title: string;
    detail: string;
}

interface GraphDetail {
    id: string;
    name: string;
    enable: boolean;
    lastUpdateTime?: number;
    nodeCount: number;
    note: string;
    text: string;
    triggers: RuleNodeItem[];
    conditions: RuleNodeItem[];
    actions: RuleNodeItem[];
}

interface GraphPanelProps {
    graphs: GraphSummary[];
    loading?: boolean;
    onRefresh: () => void;
    onToggle: (id: string, enable: boolean) => void;
    onDelete: (id: string) => void;
    onEditInChat?: (graph: { id: string; name: string }) => void;
}

type StatusFilter = 'all' | 'enabled' | 'disabled';

function formatTime(timestamp?: number): string {
    if (!timestamp) return '更新于未知时间';

    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60 * 1000) return '刚刚更新';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前更新`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前更新`;
    return `${date.toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'})} 更新`;
}

export default function GraphPanel({
    graphs,
    loading = false,
    onRefresh,
    onToggle,
    onDelete,
    onEditInChat,
}: GraphPanelProps) {
    const [searchText, setSearchText] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [selectedSummary, setSelectedSummary] = useState<GraphSummary | null>(null);
    const [detail, setDetail] = useState<GraphDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [detailTab, setDetailTab] = useState<'overview' | 'text'>('overview');
    const [copied, setCopied] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<GraphSummary | null>(null);

    const enabledCount = graphs.filter(g => g.enable).length;
    const disabledCount = graphs.length - enabledCount;
    const showInitialLoading = loading && graphs.length === 0;
    const hasFilter = searchText.trim().length > 0 || statusFilter !== 'all';

    // 过滤并按「启用优先 → 最近更新优先」排序
    const visibleGraphs = useMemo(() => {
        const keyword = searchText.trim().toLowerCase();
        return graphs
            .filter(g => {
                if (statusFilter === 'enabled' && !g.enable) return false;
                if (statusFilter === 'disabled' && g.enable) return false;
                if (keyword && !g.name.toLowerCase().includes(keyword) && !g.id.includes(keyword)) {
                    return false;
                }
                return true;
            })
            .sort((a, b) => {
                if (a.enable !== b.enable) return a.enable ? -1 : 1;
                return (b.lastUpdateTime || 0) - (a.lastUpdateTime || 0);
            });
    }, [graphs, searchText, statusFilter]);

    // 同步当前选中规则的启停状态
    const liveSelected = selectedSummary
        ? graphs.find(g => g.id === selectedSummary.id) || selectedSummary
        : null;

    const loadGraphDetail = useCallback(async (graph: GraphSummary) => {
        setSelectedSummary(graph);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        setDetailTab('overview');
        setCopied(false);

        try {
            const response = await fetch(`/api/graphs?id=${encodeURIComponent(graph.id)}`);
            const result = await response.json();
            if (result.success && result.graph) {
                setDetail(result.graph);
            } else {
                setDetailError(result.error || result.message || '未能读取规则详情');
            }
        } catch (error) {
            setDetailError(error instanceof Error ? error.message : '读取规则详情失败');
        } finally {
            setDetailLoading(false);
        }
    }, []);

    const closeModal = useCallback(() => {
        setSelectedSummary(null);
        setDetail(null);
        setDetailError(null);
    }, []);

    useEffect(() => {
        if (!selectedSummary) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedSummary, closeModal]);

    const handleCopyText = async () => {
        if (!detail?.text) return;
        try {
            await navigator.clipboard.writeText(detail.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            // 忽略剪贴板权限受限
        }
    };

    const renderSection = (title: string, items: RuleNodeItem[]) => {
        if (items.length === 0) return null;
        return (
            <section className={styles.sectionBlock}>
                <div className={styles.sectionHeader}>
                    <span>{title}</span>
                    <span className={styles.sectionCount}>{items.length}</span>
                </div>
                {items.map(item => (
                    <div key={item.id} className={styles.nodeCard}>
                        <span className={styles.nodeTitle}>{item.title}</span>
                        <span className={styles.nodeDetail}>{item.detail}</span>
                    </div>
                ))}
            </section>
        );
    };

    const modalNode =
        liveSelected && typeof document !== 'undefined'
            ? createPortal(
                <div
                    className={styles.modalBackdrop}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) closeModal();
                    }}
                >
                    <div
                        className={styles.modal}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="rule-detail-title"
                    >
                        <div className={styles.modalHeader}>
                            <div className={styles.modalTitleBlock}>
                                <div className={styles.modalTitleRow}>
                                    <span
                                        className={liveSelected.enable ? styles.dotEnabled : styles.dotDisabled}
                                        aria-hidden="true"
                                    />
                                    <h3 id="rule-detail-title" className={styles.modalTitle}>
                                        {detail?.name || liveSelected.name}
                                    </h3>
                                    <span
                                        className={`${styles.statusPill} ${
                                            liveSelected.enable ? styles.statusPillOn : ''
                                        }`}
                                    >
                                        {liveSelected.enable ? '已启用' : '已停用'}
                                    </span>
                                </div>
                                <div className={styles.modalMeta}>
                                    <span>{formatTime(detail?.lastUpdateTime ?? liveSelected.lastUpdateTime)}</span>
                                    {detail && <span>共 {detail.nodeCount} 个节点</span>}
                                    <span>ID: {liveSelected.id}</span>
                                </div>
                            </div>

                            <button
                                type="button"
                                className={styles.closeButton}
                                onClick={closeModal}
                                aria-label="关闭弹窗"
                            >
                                <CloseOutlined style={{fontSize: 13}}/>
                            </button>
                        </div>

                        <div className={styles.modalTabsBar}>
                            <div className={styles.modalTabs} role="tablist" aria-label="规则视图">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={detailTab === 'overview'}
                                    className={`${styles.modalTab} ${
                                        detailTab === 'overview' ? styles.modalTabActive : ''
                                    }`}
                                    onClick={() => setDetailTab('overview')}
                                >
                                    规则概览
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={detailTab === 'text'}
                                    className={`${styles.modalTab} ${
                                        detailTab === 'text' ? styles.modalTabActive : ''
                                    }`}
                                    onClick={() => setDetailTab('text')}
                                >
                                    规则文本
                                </button>
                            </div>

                            {detailTab === 'text' && detail?.text && (
                                <button
                                    type="button"
                                    className={styles.copyButton}
                                    onClick={handleCopyText}
                                >
                                    {copied ? '已复制' : '复制文本'}
                                </button>
                            )}
                        </div>

                        <div className={styles.modalBody}>
                            {detailLoading ? (
                                <div className={styles.skeletonList} aria-label="正在读取规则详情">
                                    {[0, 1, 2].map(i => (
                                        <div key={i} className={styles.skeletonCard}>
                                            <div className={styles.skeletonLine}/>
                                            <div className={styles.skeletonLineShort}/>
                                        </div>
                                    ))}
                                </div>
                            ) : detailError ? (
                                <div className={styles.modalError} role="alert">
                                    <span>{detailError}</span>
                                    <button
                                        type="button"
                                        className={styles.retryBtn}
                                        onClick={() => loadGraphDetail(liveSelected)}
                                    >
                                        重试
                                    </button>
                                </div>
                            ) : detail ? (
                                detailTab === 'overview' ? (
                                    <>
                                        {detail.note && (
                                            <div className={styles.noteCard}>
                                                <div className={styles.noteTitle}>规则说明</div>
                                                <div className="markdown-content">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                        {detail.note}
                                                    </ReactMarkdown>
                                                </div>
                                            </div>
                                        )}

                                        {renderSection('触发条件', detail.triggers)}
                                        {renderSection('判断与控制', detail.conditions)}
                                        {renderSection('执行动作', detail.actions)}

                                        {!detail.note &&
                                            detail.triggers.length === 0 &&
                                            detail.conditions.length === 0 &&
                                            detail.actions.length === 0 && (
                                                <p className={styles.emptyDesc}>该规则暂无可展示的节点内容。</p>
                                            )}
                                    </>
                                ) : (
                                    <pre className={styles.ruleCodeBlock}>
                                        {detail.text || '暂无规则文本表示'}
                                    </pre>
                                )
                            ) : null}
                        </div>

                        <div className={styles.modalFooter}>
                            <label className={styles.footerSwitchWrap}>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={liveSelected.enable}
                                    aria-label={`${liveSelected.enable ? '停用' : '启用'}规则「${liveSelected.name}」`}
                                    className={`${styles.switch} ${liveSelected.enable ? styles.switchOn : ''}`}
                                    onClick={() => onToggle(liveSelected.id, !liveSelected.enable)}
                                >
                                    <span className={styles.switchThumb}/>
                                </button>
                                <span>{liveSelected.enable ? '当前已启用' : '当前已停用'}</span>
                            </label>

                            <div className={styles.modalFooterActions}>
                                {onEditInChat && (
                                    <button
                                        type="button"
                                        className={styles.modalEditBtn}
                                        onClick={() => {
                                            onEditInChat({
                                                id: liveSelected.id,
                                                name: detail?.name || liveSelected.name,
                                            });
                                            closeModal();
                                        }}
                                    >
                                        <EditOutlined style={{fontSize: 13}}/>
                                        <span>让助手修改</span>
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className={styles.modalCloseBtn}
                                    onClick={closeModal}
                                >
                                    关闭
                                </button>
                            </div>
                        </div>
                    </div>
                </div>,
                document.body
            )
            : null;

    return (
        <div className={styles.panel}>
            <div className={styles.topBar}>
                <div className={styles.topBarTitleGroup}>
                    <h2 className={styles.topBarTitle}>自动化规则</h2>
                    <span className={styles.topBarCount}>共 {graphs.length} 条</span>
                </div>

                <button
                    type="button"
                    className={styles.refreshButton}
                    onClick={onRefresh}
                    disabled={loading}
                    aria-label="刷新自动化规则"
                    title="刷新自动化规则"
                >
                    <SyncOutlined spin={loading} style={{fontSize: 13}}/>
                </button>
            </div>

            <div className={styles.toolbar}>
                <div className={styles.filterPills} role="group" aria-label="按启用状态筛选">
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'all' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter('all')}
                    >
                        全部 {graphs.length}
                    </button>
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'enabled' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter(prev => (prev === 'enabled' ? 'all' : 'enabled'))}
                    >
                        <span className={styles.dotEnabled} aria-hidden="true"/>
                        启用 {enabledCount}
                    </button>
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'disabled' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter(prev => (prev === 'disabled' ? 'all' : 'disabled'))}
                    >
                        <span className={styles.dotDisabled} aria-hidden="true"/>
                        停用 {disabledCount}
                    </button>
                </div>

                <div className={styles.searchBox}>
                    <span className={styles.searchIcon} aria-hidden="true">
                        <SearchOutlined style={{fontSize: 13}}/>
                    </span>
                    <input
                        type="text"
                        className={styles.searchInput}
                        placeholder="搜索规则名称或 ID"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        aria-label="搜索自动化规则"
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
                    <div className={styles.skeletonList} aria-label="正在加载自动化规则">
                        {[0, 1, 2, 3, 4, 5].map(i => (
                            <div key={i} className={styles.skeletonCard}>
                                <div className={styles.skeletonLine}/>
                                <div className={styles.skeletonLineShort}/>
                            </div>
                        ))}
                    </div>
                ) : visibleGraphs.length === 0 ? (
                    <div className={styles.emptyState}>
                        <p className={styles.emptyTitle}>
                            {hasFilter ? '没有匹配的规则' : '暂无自动化规则'}
                        </p>
                        <p className={styles.emptyDesc}>
                            {hasFilter
                                ? '尝试更换关键词或切换启用状态筛选。'
                                : '切换到「对话」视图，用自然语言描述你想实现的智能家居联动，助手会自动为你生成并部署到中枢网关。'}
                        </p>
                        {hasFilter && (
                            <button
                                type="button"
                                className={styles.resetButton}
                                onClick={() => {
                                    setSearchText('');
                                    setStatusFilter('all');
                                }}
                            >
                                清除筛选
                            </button>
                        )}
                    </div>
                ) : (
                    <div className={styles.grid}>
                        {visibleGraphs.map(graph => {
                            const isSelected = liveSelected?.id === graph.id;
                            return (
                                <div
                                    key={graph.id}
                                    className={[
                                        styles.item,
                                        !graph.enable ? styles.itemDisabled : '',
                                        isSelected ? styles.itemSelected : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                >
                                    <div className={styles.itemTop}>
                                        <button
                                            type="button"
                                            className={styles.itemMain}
                                            onClick={() => loadGraphDetail(graph)}
                                            title={`查看「${graph.name}」详情`}
                                        >
                                            <span
                                                className={graph.enable ? styles.dotEnabled : styles.dotDisabled}
                                                aria-hidden="true"
                                            />
                                            <span
                                                className={`${styles.itemName} ${
                                                    !graph.enable ? styles.itemNameDisabled : ''
                                                }`}
                                            >
                                                {graph.name}
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={graph.enable}
                                            aria-label={`${graph.enable ? '停用' : '启用'}规则「${graph.name}」`}
                                            className={`${styles.switch} ${graph.enable ? styles.switchOn : ''}`}
                                            onClick={() => onToggle(graph.id, !graph.enable)}
                                        >
                                            <span className={styles.switchThumb}/>
                                        </button>
                                    </div>

                                    <div className={styles.itemBottom}>
                                        <span className={styles.itemTime}>{formatTime(graph.lastUpdateTime)}</span>
                                        <div className={styles.itemFootActions}>
                                            <button
                                                type="button"
                                                className={styles.inspectLink}
                                                onClick={() => loadGraphDetail(graph)}
                                            >
                                                详情
                                            </button>

                                            {onEditInChat && (
                                                <button
                                                    type="button"
                                                    className={styles.inspectLink}
                                                    onClick={() => onEditInChat({id: graph.id, name: graph.name})}
                                                >
                                                    修改
                                                </button>
                                            )}

                                            <button
                                                type="button"
                                                className={styles.deleteTrigger}
                                                aria-label={`删除规则「${graph.name}」`}
                                                title="删除规则"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setPendingDelete(graph);
                                                }}
                                            >
                                                <DeleteOutlined style={{fontSize: 12}}/>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {modalNode}
            <ConfirmModal
                open={pendingDelete !== null}
                title={`删除规则「${pendingDelete?.name || ''}」？`}
                description="删除后无法恢复，该自动化规则将从网关中永久移除。"
                confirmText="删除"
                cancelText="取消"
                danger
                onCancel={() => setPendingDelete(null)}
                onConfirm={async () => {
                    if (!pendingDelete) return;
                    if (liveSelected?.id === pendingDelete.id) closeModal();
                    await onDelete(pendingDelete.id);
                    setPendingDelete(null);
                }}
            />
        </div>
    );
}
