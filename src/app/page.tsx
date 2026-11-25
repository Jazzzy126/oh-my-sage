'use client';

import React, {useState, useCallback, useRef, useEffect} from 'react';
import dynamic from 'next/dynamic';
import {message} from 'antd';
import {
    ApartmentOutlined,
    AppstoreOutlined,
    FormOutlined,
    LogoutOutlined,
    MenuOutlined,
    SearchOutlined,
    SettingOutlined,
    SlidersOutlined,
} from '@ant-design/icons';
import Chat from '@/components/Chat';
import SessionPanel from '@/components/SessionPanel';
import LoginPage from '@/components/LoginPage';
import SettingsModal from '@/components/SettingsModal';
import {ThemeToggleButton} from '@/components/ThemeProvider';
import styles from './page.module.css';

// 非首屏面板按需懒加载，减小首页 JS 体积
const DevicePanel = dynamic(() => import('@/components/DevicePanel'), {ssr: false});
const GraphPanel = dynamic(() => import('@/components/GraphPanel'), {ssr: false});

interface SessionMeta {
    id: string;
    title: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    isActive: boolean;
}

interface SessionMessage {
    seq: number;
    role: 'user' | 'assistant' | 'compressed';
    content: string;
    timestamp: string;
    thinking?: string;
    toolCalls?: Array<{ tool: string; args?: any; result?: any; success: boolean }>;
}

interface GraphSummary {
    id: string;
    name: string;
    enable: boolean;
    lastUpdateTime?: number;
    rooms?: string[];
}

type MainView = 'chat' | 'graphs' | 'devices';

function SidebarCollapseIcon() {
    return (
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <rect x="2.25" y="2.75" width="13.5" height="12.5" rx="2.5" stroke="currentColor" strokeWidth="1.4"/>
            <line x1="6.75" y1="3.25" x2="6.75" y2="14.75" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
    );
}

function BrandGlyph({size = 20}: {size?: number}) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="15" height="15" rx="4.5" stroke="var(--ui-signal)" strokeWidth="1.75"/>
            <circle cx="10" cy="10" r="3" fill="var(--ui-signal)"/>
        </svg>
    );
}

export default function HomePage() {
    const [leftOpen, setLeftOpen] = useState(true);
    const [activeView, setActiveView] = useState<MainView>('chat');
    const [visitedViews, setVisitedViews] = useState<{ graphs: boolean; devices: boolean }>({
        graphs: false,
        devices: false,
    });
    const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
    const [draftInsert, setDraftInsert] = useState<{ text: string; seq: number } | null>(null);

    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [authChecking, setAuthChecking] = useState(true);
    const [passcode, setPasscode] = useState('');
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [devices, setDevices] = useState<any[]>([]);
    const [stats, setStats] = useState({total: 0, online: 0, offline: 0, rooms: 0});

    const [sessions, setSessions] = useState<SessionMeta[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
    const [currentMessages, setCurrentMessages] = useState<SessionMessage[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);

    const [graphs, setGraphs] = useState<GraphSummary[]>([]);
    const [graphsLoading, setGraphsLoading] = useState(false);
    const graphsLoadedRef = useRef(false);

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [configModalOpen, setConfigModalOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const settingsRef = useRef<HTMLDivElement | null>(null);

    const closeDrawerOnMobile = useCallback(() => {
        if (typeof window !== 'undefined' && window.innerWidth <= 900) {
            setLeftOpen(false);
        }
    }, []);

    const loadDevices = useCallback(async (forceRefresh = false) => {
        setDevicesLoading(true);
        try {
            const url = forceRefresh ? '/api/devices?refresh=true' : '/api/devices';
            const response = await fetch(url);
            const result = await response.json();
            if (result.success) {
                setDevices(result.devices || []);
                setStats(result.stats || {total: 0, online: 0, offline: 0, rooms: 0});
            } else {
                message.error(result.message || '加载设备失败');
            }
        } catch (error) {
            message.error('加载设备失败: ' + String(error));
        } finally {
            setDevicesLoading(false);
        }
    }, []);

    const loadSessions = useCallback(async () => {
        setSessionsLoading(true);
        try {
            const response = await fetch('/api/sessions');
            const result = await response.json();
            if (result.success) {
                setSessions(result.sessions || []);
            }
        } catch (error) {
            console.error('加载 Session 列表失败:', error);
        } finally {
            setSessionsLoading(false);
        }
    }, []);

    const loadGraphs = useCallback(async () => {
        setGraphsLoading(true);
        try {
            const response = await fetch('/api/graphs');
            const result = await response.json();
            if (result.success) {
                setGraphs(result.graphs || []);
                graphsLoadedRef.current = true;
            }
        } catch (error) {
            console.error('加载规则列表失败:', error);
        } finally {
            setGraphsLoading(false);
        }
    }, []);

    const handleLoginSuccess = async (code: string) => {
        setPasscode(code);
        setIsLoggedIn(true);
        await Promise.all([loadDevices(), loadSessions()]);
    };

    const handleLogout = useCallback(async () => {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            const response = await fetch('/api/auth', {method: 'DELETE'});
            const result = await response.json();
            if (!result.success) {
                message.error(result.message || '退出登录失败');
                return;
            }
            setSettingsOpen(false);
            setIsLoggedIn(false);
            setPasscode('');
            setDevices([]);
            setStats({total: 0, online: 0, offline: 0, rooms: 0});
            setGraphs([]);
            graphsLoadedRef.current = false;
            setActiveSessionId(undefined);
            setCurrentMessages([]);
            setActiveView('chat');
            message.success('已断开网关连接，请重新输入登录码');
        } catch (error) {
            message.error('退出登录失败: ' + String(error));
        } finally {
            setLoggingOut(false);
        }
    }, [loggingOut]);

    // 点击外部或按 Escape 关闭设置菜单
    useEffect(() => {
        if (!settingsOpen) return;
        const handlePointerDown = (e: MouseEvent) => {
            if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
                setSettingsOpen(false);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSettingsOpen(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [settingsOpen]);

    // 页面刷新后检查服务端是否已保持网关连接，已连接则直接恢复工作台
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const response = await fetch('/api/auth', {cache: 'no-store'});
                const result = await response.json();
                if (!cancelled && result.success && result.connected) {
                    setIsLoggedIn(true);
                    await Promise.all([loadDevices(), loadSessions()]);
                }
            } catch {
                // 检查失败时回退到登录页
            } finally {
                if (!cancelled) setAuthChecking(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadDevices, loadSessions]);

    const handleSelectSession = async (sessionId: string) => {
        setActiveView('chat');
        setActiveSessionId(sessionId);
        setCurrentMessages([]);
        closeDrawerOnMobile();
        try {
            const response = await fetch(`/api/sessions/${sessionId}`);
            const result = await response.json();
            if (result.success) {
                setCurrentMessages(result.messages || []);
            }
        } catch {
            message.error('加载 Session 消息失败');
        }
    };

    const handleDeleteSession = async (sessionId: string) => {
        try {
            const response = await fetch(`/api/sessions/${sessionId}`, {method: 'DELETE'});
            const result = await response.json();
            if (result.success) {
                setSessions(prev => prev.filter(s => s.id !== sessionId));
                if (activeSessionId === sessionId) {
                    setActiveSessionId(undefined);
                    setCurrentMessages([]);
                }
                message.success('对话已删除');
            }
        } catch {
            message.error('删除对话失败');
        }
    };

    const handleNewSession = () => {
        setActiveView('chat');
        setActiveSessionId(undefined);
        setCurrentMessages([]);
        closeDrawerOnMobile();
    };

    const handleSearchClick = () => {
        if (!leftOpen) {
            setLeftOpen(true);
            setSessionSearchOpen(true);
        } else {
            setSessionSearchOpen(v => !v);
        }
    };

    const handleSessionCreated = (sessionId: string, messages: SessionMessage[]) => {
        setActiveSessionId(sessionId);
        setCurrentMessages(messages);
        loadSessions();
    };

    const handleResetSession = useCallback(async (sessionId: string, seq: number) => {
        try {
            const response = await fetch(`/api/sessions/${sessionId}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({action: 'truncate', seq}),
            });
            const result = await response.json();
            if (result.success) {
                setCurrentMessages(result.messages || []);
                message.success('已回退到指定位置，修改消息后重新发送即可');
            } else {
                message.error(result.error || '回退失败');
            }
        } catch (error) {
            message.error('回退失败: ' + String(error));
        }
    }, []);

    const handleToggleGraph = async (id: string, enable: boolean) => {
        try {
            const response = await fetch('/api/graphs', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id, enable}),
            });
            const result = await response.json();
            if (result.success) {
                setGraphs(prev => prev.map(g => g.id === id ? {...g, enable} : g));
                message.success(enable ? '规则已启用' : '规则已禁用');
            } else {
                message.error(result.message || '操作失败');
            }
        } catch {
            message.error('切换规则状态失败');
        }
    };

    const handleDeleteGraph = async (id: string) => {
        try {
            const response = await fetch(`/api/graphs?id=${id}`, {method: 'DELETE'});
            const result = await response.json();
            if (result.success) {
                setGraphs(prev => prev.filter(g => g.id !== id));
                message.success('规则已删除');
            } else {
                message.error(result.message || '删除失败');
            }
        } catch {
            message.error('删除规则失败');
        }
    };

    // 监听窗口宽度变化，窄屏时自动收起左侧栏
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mqLeft = window.matchMedia('(max-width: 900px)');

        if (mqLeft.matches) setLeftOpen(false);

        const handleLeftChange = (e: MediaQueryListEvent) => {
            setLeftOpen(!e.matches);
        };

        mqLeft.addEventListener('change', handleLeftChange);
        return () => {
            mqLeft.removeEventListener('change', handleLeftChange);
        };
    }, []);

    const handleViewChange = (view: MainView) => {
        setActiveView(view);
        if (view === 'graphs' || view === 'devices') {
            setVisitedViews(prev => (prev[view] ? prev : {...prev, [view]: true}));
        }
        if (view === 'graphs' && !graphsLoadedRef.current) {
            loadGraphs();
        }
        closeDrawerOnMobile();
    };

    const handleInsertToChat = useCallback((text: string) => {
        setActiveView('chat');
        setDraftInsert(prev => ({text, seq: (prev?.seq ?? 0) + 1}));
        closeDrawerOnMobile();
    }, [closeDrawerOnMobile]);

    const handleEditGraphInChat = useCallback((graph: { id: string; name: string }) => {
        handleInsertToChat(`帮我修改规则「${graph.name}」（ID: ${graph.id}）：`);
    }, [handleInsertToChat]);

    const handleGraphsMutated = useCallback(() => {
        loadGraphs();
    }, [loadGraphs]);

    const ensureGraphsLoaded = useCallback(() => {
        if (!graphsLoadedRef.current && !graphsLoading) {
            loadGraphs();
        }
    }, [graphsLoading, loadGraphs]);

    if (authChecking) {
        return <div className={styles.shell}/>;
    }

    if (!isLoggedIn) {
        return <LoginPage onLoginSuccess={handleLoginSuccess}/>;
    }

    return (
        <div className={styles.shell}>
            {leftOpen && (
                <button
                    type="button"
                    className={styles.mobileBackdrop}
                    aria-label="收起侧边栏"
                    onClick={() => setLeftOpen(false)}
                />
            )}

            {/* 左侧导航栏：严格对齐 Gemini 展开 / 收缩两态 */}
            <aside
                className={`${styles.sidebar} ${!leftOpen ? styles.sidebarCollapsed : ''}`}
                aria-label="主导航与对话历史"
            >
                {/* 顶部行：展开为 [Logo + 名称 ... 搜索 + 收起]，收缩为 [圆形 Logo（点击展开）] */}
                <div className={styles.sidebarTop}>
                    {leftOpen ? (
                        <>
                            <button
                                type="button"
                                className={styles.sidebarBrand}
                                onClick={() => handleViewChange('chat')}
                                title="返回对话"
                            >
                                <BrandGlyph size={20}/>
                                <span className={styles.sidebarBrandName}>Oh My Sage</span>
                            </button>

                            <div className={styles.sidebarTopActions}>
                                <button
                                    type="button"
                                    className={`${styles.topIconBtn} ${sessionSearchOpen ? styles.topIconBtnActive : ''}`}
                                    onClick={handleSearchClick}
                                    aria-label="搜索对话"
                                    title="搜索对话"
                                >
                                    <SearchOutlined style={{fontSize: 16}}/>
                                </button>
                                <button
                                    type="button"
                                    className={styles.topIconBtn}
                                    onClick={() => setLeftOpen(false)}
                                    aria-label="收起侧边栏"
                                    title="收起侧边栏"
                                >
                                    <SidebarCollapseIcon/>
                                </button>
                            </div>
                        </>
                    ) : (
                        <button
                            type="button"
                            className={styles.collapsedBrandBtn}
                            onClick={() => setLeftOpen(true)}
                            aria-label="展开侧边栏"
                            title="Oh My Sage · 点击展开侧边栏"
                        >
                            <BrandGlyph size={20}/>
                        </button>
                    )}
                </div>

                {/* 发起新对话药丸（收缩态自动变为 40×40 圆形图标） */}
                <div className={styles.sidebarAction}>
                    <button
                        type="button"
                        className={`${styles.newChatPill} ${!leftOpen ? styles.newChatPillCollapsed : ''}`}
                        onClick={handleNewSession}
                        aria-label="发起新对话"
                        title="发起新对话"
                    >
                        <FormOutlined style={{fontSize: 16}}/>
                        <span className={styles.collapsibleLabel}>发起新对话</span>
                    </button>
                </div>

                {/* 主导航列表 */}
                <nav className={styles.navList} aria-label="主视图导航">
                    {!leftOpen && (
                        <button
                            type="button"
                            className={styles.navItem}
                            onClick={handleSearchClick}
                            aria-label="搜索对话"
                            title="搜索对话"
                        >
                            <SearchOutlined className={styles.navItemIcon} style={{fontSize: 16}}/>
                        </button>
                    )}

                    <button
                        type="button"
                        className={`${styles.navItem} ${activeView === 'devices' ? styles.navItemActive : ''}`}
                        aria-current={activeView === 'devices' ? 'page' : undefined}
                        onClick={() => handleViewChange('devices')}
                        title={`设备（${stats.online}/${stats.total} 在线）`}
                    >
                        <AppstoreOutlined className={styles.navItemIcon} style={{fontSize: 16}}/>
                        <span className={styles.collapsibleLabel}>设备</span>
                        {leftOpen && stats.total > 0 && (
                            <span className={styles.navBadge}>{stats.total}</span>
                        )}
                    </button>

                    <button
                        type="button"
                        className={`${styles.navItem} ${activeView === 'graphs' ? styles.navItemActive : ''}`}
                        aria-current={activeView === 'graphs' ? 'page' : undefined}
                        onClick={() => handleViewChange('graphs')}
                        title="自动化规则"
                    >
                        <ApartmentOutlined className={styles.navItemIcon} style={{fontSize: 16}}/>
                        <span className={styles.collapsibleLabel}>自动化规则</span>
                        {leftOpen && graphsLoadedRef.current && (
                            <span className={styles.navBadge}>{graphs.length}</span>
                        )}
                    </button>
                </nav>

                {/* 对话历史区：仅展开时显示，极简单行列表 */}
                <div
                    className={`${styles.sidebarSessions} ${!leftOpen ? styles.sidebarSessionsHidden : ''}`}
                    aria-hidden={!leftOpen}
                >
                    <SessionPanel
                        embedded
                        searchOpen={sessionSearchOpen}
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        loading={sessionsLoading}
                        onSelectSession={handleSelectSession}
                        onDeleteSession={handleDeleteSession}
                        onNewSession={handleNewSession}
                        onRefresh={loadSessions}
                    />
                </div>

                {/* 底部栏：展开为 [中枢状态徽章+两行文字 ... 设置]，收缩为 [设置 / 中枢徽章] 垂直对齐 */}
                <div className={`${styles.sidebarFooter} ${!leftOpen ? styles.sidebarFooterCollapsed : ''}`} ref={settingsRef}>
                    {!leftOpen && (
                        <button
                            type="button"
                            className={`${styles.footerIconBtn} ${settingsOpen ? styles.footerIconBtnActive : ''}`}
                            onClick={() => setSettingsOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={settingsOpen}
                            aria-label="设置"
                            title="设置"
                        >
                            <SettingOutlined
                                className={`${styles.settingsIcon} ${settingsOpen ? styles.settingsIconOpen : ''}`}
                                style={{fontSize: 16}}
                            />
                        </button>
                    )}

                    <button
                        type="button"
                        className={`${styles.hubProfile} ${!leftOpen ? styles.hubProfileCollapsed : ''}`}
                        onClick={() => handleViewChange('devices')}
                        aria-label={`小米中枢网关，${stats.online}/${stats.total} 设备在线`}
                        title={`小米中枢网关 · ${stats.online}/${stats.total} 设备在线`}
                    >
                        <span className={styles.hubAvatar} aria-hidden="true">
                            <span className={styles.hubAvatarDot}/>
                        </span>
                        {leftOpen && (
                            <span className={styles.hubProfileText}>
                                <span className={styles.hubProfileName}>小米中枢网关</span>
                                <span className={styles.hubProfileSub}>
                                    {stats.online}/{stats.total} 设备在线
                                </span>
                            </span>
                        )}
                    </button>

                    {leftOpen && (
                        <button
                            type="button"
                            className={`${styles.footerIconBtn} ${settingsOpen ? styles.footerIconBtnActive : ''}`}
                            onClick={() => setSettingsOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={settingsOpen}
                            aria-label="设置"
                            title="设置"
                        >
                            <SettingOutlined
                                className={`${styles.settingsIcon} ${settingsOpen ? styles.settingsIconOpen : ''}`}
                                style={{fontSize: 16}}
                            />
                        </button>
                    )}

                    {settingsOpen && (
                        <div
                            className={`${styles.settingsMenu} ${
                                leftOpen ? styles.settingsMenuUp : styles.settingsMenuRight
                            }`}
                            role="menu"
                            aria-label="设置菜单"
                        >
                            <button
                                type="button"
                                role="menuitem"
                                className={styles.settingsItem}
                                onClick={() => {
                                    setSettingsOpen(false);
                                    setConfigModalOpen(true);
                                }}
                            >
                                <span className={styles.settingsItemIcon} aria-hidden="true">
                                    <SlidersOutlined style={{fontSize: 14}}/>
                                </span>
                                <span className={styles.settingsItemText}>
                                    <span className={styles.settingsItemTitle}>模型与网关配置</span>
                                    <span className={styles.settingsItemDesc}>
                                        设置 API Key、模型及中枢网关地址
                                    </span>
                                </span>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                className={styles.settingsItem}
                                onClick={handleLogout}
                                disabled={loggingOut}
                            >
                                <span className={styles.settingsItemIcon} aria-hidden="true">
                                    <LogoutOutlined style={{fontSize: 14}}/>
                                </span>
                                <span className={styles.settingsItemText}>
                                    <span className={styles.settingsItemTitle}>
                                        {loggingOut ? '正在断开连接…' : '退出到登录页'}
                                    </span>
                                    <span className={styles.settingsItemDesc}>
                                        断开当前网关连接并重填登录码
                                    </span>
                                </span>
                            </button>
                        </div>
                    )}
                </div>
            </aside>

            {/* 右侧无边框通透全高主画布 */}
            <main className={styles.mainStage}>
                <header className={styles.canvasHeader}>
                    <div className={styles.canvasHeaderLeft}>
                        <button
                            type="button"
                            className={styles.mobileMenuButton}
                            onClick={() => setLeftOpen(v => !v)}
                            aria-expanded={leftOpen}
                            aria-label="打开导航栏"
                        >
                            <MenuOutlined style={{fontSize: 16}}/>
                        </button>
                        <span className={styles.mobileBrandName}>Oh My Sage</span>
                    </div>

                    <div className={styles.canvasHeaderRight}>
                        <ThemeToggleButton className={styles.themeButton}/>
                    </div>
                </header>

                <div className={styles.canvasBody}>
                    <div className={`${styles.viewPane} ${activeView !== 'chat' ? styles.viewPaneHidden : ''}`}>
                        <Chat
                            passcode={passcode}
                            sessionId={activeSessionId}
                            initialMessages={currentMessages}
                            draftInsert={draftInsert}
                            devices={devices}
                            graphs={graphs}
                            graphsLoading={graphsLoading}
                            onEnsureGraphsLoaded={ensureGraphsLoaded}
                            onSessionCreated={handleSessionCreated}
                            onResetSession={handleResetSession}
                            onGraphsMutated={handleGraphsMutated}
                        />
                    </div>

                    {visitedViews.graphs && (
                        <div className={`${styles.viewPane} ${activeView !== 'graphs' ? styles.viewPaneHidden : ''}`}>
                            <GraphPanel
                                graphs={graphs}
                                loading={graphsLoading}
                                onRefresh={loadGraphs}
                                onToggle={handleToggleGraph}
                                onDelete={handleDeleteGraph}
                                onEditInChat={handleEditGraphInChat}
                            />
                        </div>
                    )}

                    {visitedViews.devices && (
                        <div className={`${styles.viewPane} ${activeView !== 'devices' ? styles.viewPaneHidden : ''}`}>
                            <DevicePanel
                                devices={devices}
                                stats={stats}
                                loading={devicesLoading}
                                onRefresh={() => loadDevices(true)}
                                onInsertDevice={handleInsertToChat}
                            />
                        </div>
                    )}
                </div>
            </main>

            <SettingsModal
                open={configModalOpen}
                onClose={() => setConfigModalOpen(false)}
                onSaved={() => {
                    message.success('配置已保存，下次对话或连接立即生效');
                }}
            />
        </div>
    );
}
