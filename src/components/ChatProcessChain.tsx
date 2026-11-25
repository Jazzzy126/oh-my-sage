'use client';

import React, {useState} from 'react';
import {
    BulbOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined,
    DownOutlined,
    LoadingOutlined,
} from '@ant-design/icons';
import styles from './Chat.module.css';

export interface ToolCallItem {
    tool: string;
    args?: any;
    result?: any;
    success: boolean;
}

interface ChatProcessChainProps {
    idPrefix: string;
    thinking: string;
    toolCalls: ToolCallItem[];
    streaming: boolean;
    hasFinalContent?: boolean;
}

function formatJsonValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/**
 * 参照 Ant Design X 2.0 `Think` 组件设计实现（当前项目 antd 为 5.x，@ant-design/x 为 1.6.1）。
 * 具备浅色胶囊状态头 + 闪烁流光态 + 左侧细竖线展开区，并实现 destroyOnHidden（折叠时不挂载内部内容与序列化 JSON）。
 */
const ChatProcessChain = React.memo(function ChatProcessChain({
    idPrefix,
    thinking,
    toolCalls,
    streaming,
    hasFinalContent = false,
}: ChatProcessChainProps) {
    const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
    const [openTools, setOpenTools] = useState<Record<number, boolean>>({});

    if (!thinking && toolCalls.length === 0) return null;

    // 思考或工具执行中默认展开；正文开始输出或完成后自动收起，仍支持手动展开
    const expanded = manualExpanded !== null ? manualExpanded : (streaming && !hasFinalContent);
    const runningTool = toolCalls.find(tc => !tc.success && tc.result === undefined);

    const statusTitle = streaming
        ? runningTool
            ? `正在调用 ${runningTool.tool}…`
            : '正在思考…'
        : toolCalls.length > 0
            ? `已深度思考 · 执行了 ${toolCalls.length} 个步骤`
            : '已深度思考';

    const toggleToolDetail = (idx: number) => {
        setOpenTools(prev => ({...prev, [idx]: !prev[idx]}));
    };

    return (
        <div className={styles.thinkRoot}>
            <button
                type="button"
                className={styles.thinkStatus}
                aria-expanded={expanded}
                onClick={() => setManualExpanded(!expanded)}
            >
                <span className={styles.thinkIcon} aria-hidden="true">
                    {streaming ? <LoadingOutlined/> : <BulbOutlined/>}
                </span>
                <span className={`${styles.thinkTitle} ${streaming ? styles.thinkBlink : ''}`}>
                    {statusTitle}
                </span>
                <span
                    className={`${styles.thinkArrow} ${expanded ? styles.thinkArrowExpanded : ''}`}
                    aria-hidden="true"
                >
                    <DownOutlined/>
                </span>
            </button>

            {expanded && (
                <div className={styles.thinkContent}>
                    {thinking && <div className={styles.thinkText}>{thinking}</div>}

                    {toolCalls.length > 0 && (
                        <div className={styles.thinkTools}>
                            {toolCalls.map((tc, i) => {
                                const isRunning = !tc.success && tc.result === undefined;
                                const hasDetail = Boolean(
                                    (tc.args && Object.keys(tc.args).length > 0) || tc.result !== undefined
                                );
                                const isDetailOpen = Boolean(openTools[i]);
                                const statusLabel = tc.success ? '完成' : isRunning ? '执行中' : '失败';

                                return (
                                    <div key={`${idPrefix}-tool-${i}`} className={styles.thinkToolRow}>
                                        <button
                                            type="button"
                                            className={styles.thinkToolBtn}
                                            onClick={() => hasDetail && toggleToolDetail(i)}
                                            disabled={!hasDetail}
                                        >
                                            {isRunning ? (
                                                <LoadingOutlined style={{color: 'var(--ui-signal)', fontSize: 12}}/>
                                            ) : tc.success ? (
                                                <CheckCircleOutlined style={{color: 'var(--ui-online)', fontSize: 12}}/>
                                            ) : (
                                                <CloseCircleOutlined style={{color: 'var(--ui-alert)', fontSize: 12}}/>
                                            )}
                                            <span className={styles.thinkToolName}>{tc.tool}</span>
                                            <span className={styles.thinkToolMeta}>
                                                {statusLabel}
                                                {hasDetail ? (isDetailOpen ? ' · 收起参数' : ' · 查看详情') : ''}
                                            </span>
                                        </button>

                                        {hasDetail && isDetailOpen && (
                                            <div className={styles.thoughtToolDetail}>
                                                {tc.args && Object.keys(tc.args).length > 0 && (
                                                    <pre className={styles.toolCode}>{formatJsonValue(tc.args)}</pre>
                                                )}
                                                {tc.result !== undefined && (
                                                    <pre className={styles.toolCode}>{formatJsonValue(tc.result)}</pre>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

export default ChatProcessChain;
