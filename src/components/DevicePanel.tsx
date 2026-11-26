'use client';

import React, {useEffect, useMemo, useState} from 'react';
import {createPortal} from 'react-dom';
import {
    AppstoreOutlined,
    BulbOutlined,
    CameraOutlined,
    CloseOutlined,
    ExpandAltOutlined,
    LockOutlined,
    MessageOutlined,
    RightOutlined,
    SearchOutlined,
    ShrinkOutlined,
    SyncOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import styles from './DevicePanel.module.css';

interface Device {
    did: string;
    name: string;
    model: string;
    modelName?: string;
    online: boolean;
    roomName?: string;
}

interface DevicePanelProps {
    devices?: Device[];
    stats?: {
        total: number;
        online: number;
        offline: number;
        rooms: number;
    };
    loading?: boolean;
    onRefresh?: () => void;
    onInsertDevice?: (deviceName: string) => void;
}

interface RoomGroup {
    name: string;
    onlineCount: number;
    devices: Device[];
}

type StatusFilter = 'all' | 'online' | 'offline';

type DeviceCategory = 'light' | 'power' | 'camera' | 'security' | 'default';

function getDeviceCategory(model: string): DeviceCategory {
    const lower = model.toLowerCase();
    if (lower.includes('light') || lower.includes('lamp') || lower.includes('ceiling') || lower.includes('bulb')) {
        return 'light';
    }
    if (lower.includes('switch') || lower.includes('plug') || lower.includes('relay')) {
        return 'power';
    }
    if (lower.includes('camera') || lower.includes('speaker') || lower.includes('tv')) {
        return 'camera';
    }
    if (lower.includes('lock') || lower.includes('door') || lower.includes('sensor') || lower.includes('motion')) {
        return 'security';
    }
    return 'default';
}

function getCategoryIconClass(category: DeviceCategory, online: boolean): string {
    if (!online) return '';
    switch (category) {
        case 'light':
            return styles.deviceIconWarm;
        case 'power':
            return styles.deviceIconSignal;
        case 'camera':
            return styles.deviceIconMedia;
        case 'security':
            return styles.deviceIconInfo;
        default:
            return '';
    }
}

function DeviceIcon({model}: {model: string}) {
    const category = getDeviceCategory(model);
    if (category === 'light') return <BulbOutlined style={{fontSize: 13}}/>;
    if (category === 'power') return <ThunderboltOutlined style={{fontSize: 13}}/>;
    if (category === 'camera') return <CameraOutlined style={{fontSize: 13}}/>;
    if (category === 'security') return <LockOutlined style={{fontSize: 13}}/>;
    return <AppstoreOutlined style={{fontSize: 13}}/>;
}

export default function DevicePanel({
    devices = [],
    stats,
    loading = false,
    onRefresh,
    onInsertDevice,
}: DevicePanelProps) {
    const [searchText, setSearchText] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>({});
    const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);

    useEffect(() => {
        if (!selectedDevice) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSelectedDevice(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDevice]);

    const filteredRooms = useMemo<RoomGroup[]>(() => {
        const keyword = searchText.trim().toLowerCase();
        const roomMap: Record<string, Device[]> = {};

        for (const device of devices) {
            if (statusFilter === 'online' && !device.online) continue;
            if (statusFilter === 'offline' && device.online) continue;
            if (keyword) {
                const matchName = device.name.toLowerCase().includes(keyword);
                const matchModel = device.model.toLowerCase().includes(keyword);
                const matchRoom = (device.roomName || '').toLowerCase().includes(keyword);
                if (!matchName && !matchModel && !matchRoom) continue;
            }
            const roomName = device.roomName || '未分组';
            if (!roomMap[roomName]) roomMap[roomName] = [];
            roomMap[roomName].push(device);
        }

        return Object.entries(roomMap).map(([name, devs]) => ({
            name,
            onlineCount: devs.filter(d => d.online).length,
            devices: devs,
        }));
    }, [devices, searchText, statusFilter]);

    const isSearching = searchText.trim().length > 0;

    // 房间默认折叠；输入搜索词时自动展开匹配房间以便直接查看结果
    const isRoomOpen = (roomName: string): boolean => {
        if (isSearching) {
            return expandedRooms[roomName] !== false;
        }
        return Boolean(expandedRooms[roomName]);
    };

    const toggleRoom = (roomName: string) => {
        setExpandedRooms(prev => {
            const currentlyOpen = isSearching ? prev[roomName] !== false : Boolean(prev[roomName]);
            return {...prev, [roomName]: !currentlyOpen};
        });
    };

    const allCollapsed =
        filteredRooms.length > 0 && filteredRooms.every(room => !isRoomOpen(room.name));

    const handleToggleAllRooms = () => {
        const shouldOpen = allCollapsed;
        setExpandedRooms(prev => {
            const next = {...prev};
            for (const room of filteredRooms) {
                next[room.name] = shouldOpen;
            }
            return next;
        });
    };

    const totalCount = stats?.total ?? devices.length;
    const roomCount = stats?.rooms ?? filteredRooms.length;
    const showInitialLoading = loading && devices.length === 0;
    const hasFilter = searchText.trim().length > 0 || statusFilter !== 'all';

    return (
        <div className={styles.panel}>
            <div className={styles.topBar}>
                <div className={styles.topBarTitleGroup}>
                    <h2 className={styles.topBarTitle}>设备</h2>
                    <span className={styles.topBarCount}>
                        {totalCount} 台{roomCount > 0 ? ` · ${roomCount} 个房间` : ''}
                    </span>
                </div>

                <div className={styles.headerActions}>
                    {filteredRooms.length > 0 && (
                        <button
                            type="button"
                            className={styles.refreshButton}
                            onClick={handleToggleAllRooms}
                            aria-label={allCollapsed ? '展开全部房间' : '折叠全部房间'}
                            title={allCollapsed ? '展开全部房间' : '折叠全部房间'}
                        >
                            {allCollapsed ? (
                                <ExpandAltOutlined style={{fontSize: 14}}/>
                            ) : (
                                <ShrinkOutlined style={{fontSize: 14}}/>
                            )}
                        </button>
                    )}

                    {onRefresh && (
                        <button
                            type="button"
                            className={styles.refreshButton}
                            onClick={onRefresh}
                            disabled={loading}
                            aria-label="刷新设备列表"
                            title="刷新设备列表"
                        >
                            <SyncOutlined spin={loading} style={{fontSize: 13}}/>
                        </button>
                    )}
                </div>
            </div>

            <div className={styles.toolbar}>
                <div className={styles.filterPills} role="group" aria-label="按在线状态筛选">
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'all' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter('all')}
                    >
                        全部 {totalCount}
                    </button>
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'online' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter(prev => (prev === 'online' ? 'all' : 'online'))}
                    >
                        <span className={styles.dotOnline} aria-hidden="true"/>
                        在线 {stats?.online ?? 0}
                    </button>
                    <button
                        type="button"
                        className={`${styles.filterPill} ${statusFilter === 'offline' ? styles.filterPillActive : ''}`}
                        onClick={() => setStatusFilter(prev => (prev === 'offline' ? 'all' : 'offline'))}
                    >
                        <span className={styles.dotOffline} aria-hidden="true"/>
                        离线 {stats?.offline ?? 0}
                    </button>
                </div>

                <div className={styles.searchBox}>
                    <span className={styles.searchIcon} aria-hidden="true">
                        <SearchOutlined style={{fontSize: 13}}/>
                    </span>
                    <input
                        type="text"
                        className={styles.searchInput}
                        placeholder="搜索设备、房间或型号"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        aria-label="搜索设备"
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
                <div className={styles.roomsWrap}>
                    {showInitialLoading ? (
                        <div className={styles.skeletonList} aria-label="正在加载设备">
                            {[0, 1, 2, 3, 4].map(i => (
                                <div key={i} className={styles.skeletonRow}/>
                            ))}
                        </div>
                    ) : filteredRooms.length === 0 ? (
                        <div className={styles.emptyState}>
                            <p className={styles.emptyTitle}>
                                {hasFilter ? '没有匹配的设备' : '暂无设备'}
                            </p>
                            <p className={styles.emptyDesc}>
                                {hasFilter
                                    ? '尝试更换关键词或切换在线状态筛选。'
                                    : '中枢网关尚未返回设备列表，可以点击右上角刷新。'}
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
                        filteredRooms.map((room) => {
                            const isOpen = isRoomOpen(room.name);
                            return (
                                <section key={room.name} className={styles.roomGroup}>
                                    <button
                                        type="button"
                                        className={styles.roomHeader}
                                        onClick={() => toggleRoom(room.name)}
                                        aria-expanded={isOpen}
                                    >
                                        <span className={styles.roomTitleWrap}>
                                            <RightOutlined
                                                className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
                                                style={{fontSize: 10}}
                                            />
                                            <span className={styles.roomName}>{room.name}</span>
                                        </span>
                                        <span className={styles.roomCount}>
                                            {room.onlineCount}/{room.devices.length} 在线
                                        </span>
                                    </button>

                                    <div
                                        className={`${styles.deviceListWrap} ${
                                            !isOpen ? styles.deviceListWrapCollapsed : ''
                                        }`}
                                        aria-hidden={!isOpen}
                                    >
                                        <div className={styles.deviceListInner}>
                                            <div className={styles.deviceList}>
                                                {room.devices.map((device) => (
                                                    <div
                                                        key={device.did}
                                                        className={`${styles.deviceRow} ${
                                                            !device.online ? styles.deviceRowOffline : ''
                                                        }`}
                                                        title={`${device.name} (${device.model})`}
                                                    >
                                                        <button
                                                            type="button"
                                                            className={styles.deviceMain}
                                                            onClick={() => setSelectedDevice(device)}
                                                        >
                                                            <span
                                                                className={`${styles.deviceIcon} ${getCategoryIconClass(
                                                                    getDeviceCategory(device.model),
                                                                    device.online
                                                                )}`}
                                                            >
                                                                <DeviceIcon model={device.model}/>
                                                            </span>
                                                            <span className={styles.deviceName}>{device.name}</span>
                                                        </button>
                                                        <div className={styles.deviceRight}>
                                                            {onInsertDevice && (
                                                                <button
                                                                    type="button"
                                                                    className={styles.insertTrigger}
                                                                    onClick={() => onInsertDevice(`「${device.name}」（DID: ${device.did}）`)}
                                                                    aria-label={`在对话中引用「${device.name}」`}
                                                                    title="引用到对话"
                                                                >
                                                                    <MessageOutlined style={{fontSize: 12}}/>
                                                                </button>
                                                            )}
                                                            <span
                                                                className={`${styles.deviceStatus} ${
                                                                    device.online ? styles.deviceStatusOnline : ''
                                                                }`}
                                                            >
                                                                <span
                                                                    className={device.online ? styles.dotOnline : styles.dotOffline}
                                                                    aria-hidden="true"
                                                                />
                                                                <span>{device.online ? '在线' : '离线'}</span>
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </section>
                            );
                        })
                    )}
                </div>
            </div>

            {selectedDevice && typeof document !== 'undefined' && createPortal(
                <div
                    className={styles.modalBackdrop}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setSelectedDevice(null);
                    }}
                >
                    <div
                        className={styles.modal}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="device-detail-title"
                    >
                        <div className={styles.modalHeader}>
                            <div className={styles.modalTitleRow}>
                                <span
                                    className={`${styles.deviceIcon} ${getCategoryIconClass(
                                        getDeviceCategory(selectedDevice.model),
                                        selectedDevice.online
                                    )}`}
                                >
                                    <DeviceIcon model={selectedDevice.model}/>
                                </span>
                                <h3 id="device-detail-title" className={styles.modalTitle}>
                                    {selectedDevice.name}
                                </h3>
                            </div>
                            <button
                                type="button"
                                className={styles.closeButton}
                                onClick={() => setSelectedDevice(null)}
                                aria-label="关闭弹窗"
                            >
                                <CloseOutlined style={{fontSize: 12}}/>
                            </button>
                        </div>

                        <div className={styles.modalBody}>
                            <div className={styles.detailRow}>
                                <span className={styles.detailLabel}>在线状态</span>
                                <span
                                    className={`${styles.deviceStatus} ${
                                        selectedDevice.online ? styles.deviceStatusOnline : ''
                                    }`}
                                >
                                    <span
                                        className={selectedDevice.online ? styles.dotOnline : styles.dotOffline}
                                        aria-hidden="true"
                                    />
                                    <span>{selectedDevice.online ? '在线' : '离线'}</span>
                                </span>
                            </div>
                            <div className={styles.detailRow}>
                                <span className={styles.detailLabel}>所属房间</span>
                                <span className={styles.detailValue}>{selectedDevice.roomName || '未分组'}</span>
                            </div>
                            <div className={styles.detailRow}>
                                <span className={styles.detailLabel}>设备型号</span>
                                <span className={`${styles.detailValue} ${styles.detailMono}`}>
                                    {selectedDevice.modelName || selectedDevice.model}
                                </span>
                            </div>
                            <div className={styles.detailRow}>
                                <span className={styles.detailLabel}>设备 ID</span>
                                <span className={`${styles.detailValue} ${styles.detailMono}`}>
                                    {selectedDevice.did}
                                </span>
                            </div>
                        </div>

                        <div className={styles.modalFooter}>
                            <button
                                type="button"
                                className={styles.modalSecondaryBtn}
                                onClick={() => setSelectedDevice(null)}
                            >
                                关闭
                            </button>
                            {onInsertDevice && (
                                <button
                                    type="button"
                                    className={styles.modalPrimaryBtn}
                                    onClick={() => {
                                        onInsertDevice(`「${selectedDevice.name}」（DID: ${selectedDevice.did}）`);
                                        setSelectedDevice(null);
                                    }}
                                >
                                    <MessageOutlined style={{fontSize: 13}}/>
                                    <span>提到对话中</span>
                                </button>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
