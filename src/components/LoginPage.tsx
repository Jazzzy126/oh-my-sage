'use client';

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {CheckOutlined, LockOutlined, RightOutlined, SettingOutlined} from '@ant-design/icons';
import {ThemeToggleButton} from '@/components/ThemeProvider';
import SettingsModal, {type PublicRuntimeSettings} from '@/components/SettingsModal';
import styles from './LoginPage.module.css';

interface LoginPageProps {
    onLoginSuccess: (passcode: string) => void;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

const PASSCODE_LENGTH = 6;

// 6 段环形刻度弧线（围绕中心 (140, 140)，半径 108），每段 46°，间隔 14°
function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
    const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(rad(startAngle));
    const y1 = cy + radius * Math.sin(rad(startAngle));
    const x2 = cx + radius * Math.cos(rad(endAngle));
    const y2 = cy + radius * Math.sin(rad(endAngle));
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const ARC_SEGMENTS = Array.from({length: PASSCODE_LENGTH}, (_, idx) => {
    const start = idx * 60 + 7;
    const end = idx * 60 + 53;
    return describeArc(140, 140, 108, start, end);
});

export default function LoginPage({onLoginSuccess}: LoginPageProps) {
    const [digits, setDigits] = useState<string[]>(Array(PASSCODE_LENGTH).fill(''));
    const [status, setStatus] = useState<ConnectionState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [shakeSeq, setShakeSeq] = useState(0);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [runtimeSettings, setRuntimeSettings] = useState<PublicRuntimeSettings | null>(null);
    const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
    const isLoggingRef = useRef(false);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const passcode = digits.join('');
    const filledCount = digits.filter(Boolean).length;
    const isConnecting = status === 'connecting';
    const isConnected = status === 'connected';
    const isBusy = isConnecting || isConnected;

    useEffect(() => {
        inputRefs.current[0]?.focus();
        fetch('/api/settings')
            .then(res => res.json())
            .then(result => {
                if (result.success && result.settings) {
                    setRuntimeSettings(result.settings as PublicRuntimeSettings);
                }
            })
            .catch(() => {
                // ignore initial settings fetch failure
            });
        return () => {
            if (successTimerRef.current) clearTimeout(successTimerRef.current);
        };
    }, []);

    const doLogin = useCallback(async (code: string) => {
        if (code.length !== PASSCODE_LENGTH || isLoggingRef.current) return;
        isLoggingRef.current = true;
        setStatus('connecting');
        setErrorMessage(null);

        try {
            const response = await fetch('/api/auth', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({passcode: code}),
            });
            const result = await response.json();

            if (result.success) {
                setStatus('connected');
                // 留出短暂的成功定格动画，再切入主工作台
                successTimerRef.current = setTimeout(() => {
                    onLoginSuccess(code);
                }, 420);
            } else {
                setStatus('error');
                setShakeSeq(s => s + 1);
                setErrorMessage(result.message || '网关拒绝了该登录码');
                isLoggingRef.current = false;
            }
        } catch (error) {
            setStatus('error');
            setShakeSeq(s => s + 1);
            setErrorMessage(
                error instanceof Error ? error.message : '无法联系本地服务，请检查网络或服务状态'
            );
            isLoggingRef.current = false;
        }
    }, [onLoginSuccess]);

    const updateDigitsAndMaybeSubmit = useCallback(
        (nextDigits: string[], focusIndex?: number) => {
            setDigits(nextDigits);
            if (status === 'error') {
                setStatus('idle');
                setErrorMessage(null);
            }

            if (typeof focusIndex === 'number') {
                const clamped = Math.max(0, Math.min(PASSCODE_LENGTH - 1, focusIndex));
                inputRefs.current[clamped]?.focus();
            }

            const code = nextDigits.join('');
            if (code.length === PASSCODE_LENGTH) {
                setTimeout(() => doLogin(code), 0);
            }
        },
        [doLogin, status]
    );

    const handleDigitChange = (index: number, rawValue: string) => {
        if (isBusy) return;
        const cleaned = rawValue.replace(/\D/g, '');

        if (!cleaned) {
            const next = [...digits];
            next[index] = '';
            updateDigitsAndMaybeSubmit(next);
            return;
        }

        // 支持自动填充或一次输入多位数字
        if (cleaned.length > 1) {
            const next = [...digits];
            for (let i = 0; i < cleaned.length && index + i < PASSCODE_LENGTH; i++) {
                next[index + i] = cleaned[i];
            }
            const nextFocus = Math.min(index + cleaned.length, PASSCODE_LENGTH - 1);
            updateDigitsAndMaybeSubmit(next, nextFocus);
            return;
        }

        const next = [...digits];
        next[index] = cleaned;
        const nextFocus = index < PASSCODE_LENGTH - 1 ? index + 1 : index;
        updateDigitsAndMaybeSubmit(next, nextFocus);
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (isBusy) return;

        if (e.key === 'Backspace') {
            e.preventDefault();
            const next = [...digits];
            if (next[index]) {
                next[index] = '';
                updateDigitsAndMaybeSubmit(next, index);
            } else if (index > 0) {
                next[index - 1] = '';
                updateDigitsAndMaybeSubmit(next, index - 1);
            }
            return;
        }

        if (e.key === 'ArrowLeft' && index > 0) {
            e.preventDefault();
            inputRefs.current[index - 1]?.focus();
            return;
        }

        if (e.key === 'ArrowRight' && index < PASSCODE_LENGTH - 1) {
            e.preventDefault();
            inputRefs.current[index + 1]?.focus();
            return;
        }

        if (e.key === 'Enter' && passcode.length === PASSCODE_LENGTH) {
            e.preventDefault();
            doLogin(passcode);
        }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        if (isBusy) return;
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PASSCODE_LENGTH);
        if (!pasted) return;
        e.preventDefault();

        const next = Array(PASSCODE_LENGTH).fill('');
        for (let i = 0; i < pasted.length; i++) {
            next[i] = pasted[i];
        }
        const focusIdx = Math.min(pasted.length, PASSCODE_LENGTH - 1);
        updateDigitsAndMaybeSubmit(next, focusIdx);
    };

    const handleClear = () => {
        if (isBusy) return;
        setDigits(Array(PASSCODE_LENGTH).fill(''));
        setStatus('idle');
        setErrorMessage(null);
        inputRefs.current[0]?.focus();
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        doLogin(passcode);
    };

    const statusCopy = (() => {
        if (status === 'connected') return '本地加密通道已就绪';
        if (status === 'connecting') return '正在与中枢网关握手…';
        if (status === 'error') return '握手未完成';
        if (filledCount === 0) return '等待输入 6 位动态登录码';
        return '正在录入登录码';
    })();

    const errorHint = errorMessage?.includes('网关地址') || errorMessage?.includes('GATEWAY_URL')
        ? '请先点击上方「服务配置」填写局域网中枢网关地址。'
        : '登录码会定时刷新，请确认与中枢网关当前显示一致，或检查局域网连通性。';

    const ledColor =
        status === 'error'
            ? 'var(--ui-alert)'
            : status === 'connecting' || status === 'connected' || filledCount > 0
                ? 'var(--ui-signal)'
                : 'var(--ui-hub-led-idle)';

    const renderDigitInput = (index: number) => {
        const value = digits[index];
        const classNames = [
            styles.digitInput,
            value ? styles.digitInputFilled : '',
            isConnecting ? styles.digitInputConnecting : '',
            isConnected ? styles.digitInputConnected : '',
            status === 'error' ? styles.digitInputError : '',
        ]
            .filter(Boolean)
            .join(' ');

        return (
            <input
                key={index}
                ref={(el) => {
                    inputRefs.current[index] = el;
                }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                aria-label={`登录码第 ${index + 1} 位`}
                maxLength={PASSCODE_LENGTH}
                value={value}
                disabled={isBusy}
                className={classNames}
                style={isConnecting ? {animationDelay: `${index * 90}ms`} : undefined}
                onChange={(e) => handleDigitChange(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
                onPaste={handlePaste}
                onFocus={(e) => e.currentTarget.select()}
            />
        );
    };

    return (
        <main className={styles.page}>
            {/* 左侧：输入与引导 */}
            <section className={styles.workspace} aria-label="中枢网关登录">
                <header className={styles.topBar}>
                    <div className={styles.brand}>
                        <span className={styles.brandMark} aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                                <rect x="2.5" y="2.5" width="15" height="15" rx="4.5" stroke="var(--ui-signal)" strokeWidth="1.75"/>
                                <circle cx="10" cy="10" r="3" fill="var(--ui-signal)"/>
                            </svg>
                        </span>
                        <span>Oh My Sage</span>
                    </div>
                    <div className={styles.topBarActions}>
                        <button
                            type="button"
                            className={styles.configButton}
                            onClick={() => setSettingsOpen(true)}
                            title="配置网关地址与 AI 模型"
                        >
                            <SettingOutlined style={{fontSize: 13}}/>
                            <span>服务配置</span>
                            {runtimeSettings && (
                                <span
                                    className={`${styles.configDot} ${
                                        !runtimeSettings.gatewayConfigured ? styles.configDotWarn : ''
                                    }`}
                                    aria-hidden="true"
                                />
                            )}
                        </button>
                        <ThemeToggleButton className={styles.themeToggle}/>
                    </div>
                </header>

                <form className={styles.formColumn} onSubmit={handleSubmit} noValidate>
                    <div className={styles.securityPill}>
                        <LockOutlined style={{fontSize: 11}}/>
                        <span>局域网直连 · ECJPAKE 加密握手</span>
                    </div>

                    <h1 className={styles.heading}>连接中枢网关</h1>
                    <p className={styles.lead}>
                        输入米家自动化极客版显示的 6 位一次性登录码，系统将直接与局域网内的中枢网关建立加密连接。
                    </p>

                    {runtimeSettings && !runtimeSettings.gatewayConfigured && (
                        <div className={`${styles.configBanner} ${styles.configBannerWarn}`}>
                            <span className={styles.configBannerText}>
                                尚未配置中枢网关地址，连接前请先完成设置
                            </span>
                            <button
                                type="button"
                                className={styles.configBannerBtn}
                                onClick={() => setSettingsOpen(true)}
                            >
                                立即配置
                            </button>
                        </div>
                    )}

                    {runtimeSettings?.gatewayConfigured && (
                        <div className={styles.configBanner}>
                            <span className={styles.configBannerText}>
                                目标网关：{runtimeSettings.gatewayUrl}
                                {!runtimeSettings.llmConfigured ? '（AI 模型待配置）' : ''}
                            </span>
                            <button
                                type="button"
                                className={`${styles.configBannerBtn} ${styles.configBannerBtnGhost}`}
                                onClick={() => setSettingsOpen(true)}
                            >
                                修改
                            </button>
                        </div>
                    )}

                    <div className={styles.passcodeField}>
                        <div className={styles.passcodeLabelRow}>
                            <span className={styles.passcodeLabel}>6 位动态登录码</span>
                            {filledCount > 0 && (
                                <button
                                    type="button"
                                    className={styles.clearButton}
                                    onClick={handleClear}
                                    disabled={isBusy}
                                >
                                    清空重输
                                </button>
                            )}
                        </div>

                        <div
                            key={shakeSeq}
                            className={`${styles.digitRow} ${status === 'error' ? styles.digitRowShake : ''}`}
                            role="group"
                            aria-label="6 位数字登录码"
                        >
                            <div className={styles.digitGroup}>
                                {[0, 1, 2].map(renderDigitInput)}
                            </div>
                            <span
                                className={`${styles.digitSeparator} ${
                                    filledCount >= 3 ? styles.digitSeparatorActive : ''
                                }`}
                                aria-hidden="true"
                            />
                            <div className={styles.digitGroup}>
                                {[3, 4, 5].map(renderDigitInput)}
                            </div>
                        </div>
                    </div>

                    {status === 'error' && errorMessage && (
                        <div className={styles.errorBox} role="alert">
                            <div className={styles.errorTitle}>{errorMessage}</div>
                            <div className={styles.errorHint}>{errorHint}</div>
                        </div>
                    )}

                    <button
                        type="submit"
                        className={[
                            styles.submitButton,
                            isConnecting ? styles.submitButtonConnecting : '',
                            isConnected ? styles.submitButtonConnected : '',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                        disabled={passcode.length !== PASSCODE_LENGTH || isBusy}
                    >
                        {isConnecting && <span className={styles.spinner} aria-hidden="true"/>}
                        {isConnected && <CheckOutlined style={{fontSize: 15}}/>}
                        <span>
                            {isConnected
                                ? '已连接中枢网关'
                                : isConnecting
                                    ? '正在建立本地加密连接…'
                                    : '连接网关'}
                        </span>
                    </button>

                    <p className={styles.helperRow}>
                        输满 6 位后自动发起握手，也可以直接粘贴 6 位数字。
                    </p>

                    <details className={styles.helpDetails}>
                        <summary className={styles.helpSummary}>
                            <RightOutlined className={styles.helpChevron} style={{fontSize: 10}}/>
                            <span>在哪里查看登录码？</span>
                        </summary>
                        <ol className={styles.helpSteps}>
                            <li>打开米家自动化极客版网页或中枢网关本地管理后台。</li>
                            <li>在配对提示中读取当前有效的 6 位一次性数字登录码。</li>
                            <li>
                                确认本机与中枢网关在同一局域网，且已在右上角「服务配置」中填写中枢网关地址。
                            </li>
                        </ol>
                    </details>
                </form>

                <footer className={styles.footer}>
                    本地局域网直连，登录码仅用于当前会话握手。
                </footer>
            </section>

            <SettingsModal
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onSaved={(saved) => {
                    setRuntimeSettings(saved);
                    if (status === 'error') {
                        setStatus('idle');
                        setErrorMessage(null);
                    }
                }}
            />

            {/* 右侧：中枢网关实时握手示意 */}
            <aside
                className={[
                    styles.stage,
                    isConnecting ? styles.stageConnecting : '',
                    isConnected ? styles.stageConnected : '',
                    status === 'error' ? styles.stageError : '',
                ]
                    .filter(Boolean)
                    .join(' ')}
                aria-hidden="true"
            >
                <div className={styles.stageContent}>
                    <div className={styles.hubStageWrap}>
                        <svg className={styles.hubDiagram} viewBox="0 0 280 280" fill="none">
                            {/* 连接中向外扩散的双层雷达信号波纹 */}
                            {isConnecting && (
                                <g className={styles.rippleGroup}>
                                    <circle
                                        cx="140"
                                        cy="140"
                                        r="72"
                                        stroke="var(--ui-signal)"
                                        strokeWidth="1.5"
                                        className={styles.rippleWave}
                                    />
                                    <circle
                                        cx="140"
                                        cy="140"
                                        r="72"
                                        stroke="var(--ui-signal)"
                                        strokeWidth="1.5"
                                        className={`${styles.rippleWave} ${styles.rippleWaveDelay}`}
                                    />
                                </g>
                            )}

                            {/* 连接成功时的柔和定格光环 */}
                            {isConnected && (
                                <circle
                                    cx="140"
                                    cy="140"
                                    r="124"
                                    stroke="var(--ui-signal)"
                                    strokeWidth="2"
                                    className={styles.successRing}
                                />
                            )}

                            {/* 外圈基准轨道（连接中缓慢旋转） */}
                            <circle
                                cx="140"
                                cy="140"
                                r="124"
                                stroke="var(--ui-hub-track)"
                                strokeWidth="1"
                                strokeDasharray="2 5"
                                className={isConnecting ? styles.orbitSpinSlow : undefined}
                            />

                            {/* 随 6 位输入逐段点亮的握手刻度弧（连接中旋转追光） */}
                            <g className={isConnecting ? styles.arcGroupSpin : undefined}>
                                {ARC_SEGMENTS.map((path, idx) => {
                                    const isLit = idx < filledCount || isBusy;
                                    const strokeColor =
                                        status === 'error'
                                            ? 'var(--ui-alert)'
                                            : isLit
                                                ? 'var(--ui-signal)'
                                                : 'var(--ui-hub-arc-off)';
                                    return (
                                        <path
                                            key={idx}
                                            d={path}
                                            stroke={strokeColor}
                                            strokeWidth={isLit ? 4 : 2.5}
                                            strokeLinecap="round"
                                            className={`${styles.arcSegment} ${
                                                isConnecting ? styles.arcSegmentPulse : ''
                                            }`}
                                            style={isConnecting ? {animationDelay: `${idx * 140}ms`} : undefined}
                                        />
                                    );
                                })}
                            </g>

                            {/* 网关投影 */}
                            <rect
                                x="76"
                                y="84"
                                width="128"
                                height="128"
                                rx="28"
                                fill="var(--ui-hub-shadow)"
                            />

                            {/* 小米中枢网关哑光机身 */}
                            <rect
                                x="74"
                                y="74"
                                width="132"
                                height="132"
                                rx="28"
                                fill="var(--ui-hub-body)"
                                stroke={isConnected ? 'var(--ui-signal-border)' : 'var(--ui-hub-stroke)'}
                                strokeWidth="1.5"
                                className={styles.hubBody}
                            />

                            {/* 顶部倒角内框 */}
                            <rect
                                x="84"
                                y="84"
                                width="112"
                                height="112"
                                rx="20"
                                fill="var(--ui-hub-inner)"
                                stroke="var(--ui-hub-inner-stroke)"
                                strokeWidth="1"
                            />

                            {/* 细微散热/信号纹理线 */}
                            <line x1="112" y1="104" x2="168" y2="104" stroke="var(--ui-hub-line)" strokeWidth="1.5" strokeLinecap="round"/>
                            <line x1="122" y1="111" x2="158" y2="111" stroke="var(--ui-hub-line-soft)" strokeWidth="1.5" strokeLinecap="round"/>

                            {/* 中央状态指示灯 / 成功对勾 */}
                            <circle
                                cx="140"
                                cy="144"
                                r="20"
                                fill={
                                    status === 'error'
                                        ? 'var(--ui-alert-bg)'
                                        : isConnected
                                            ? 'var(--ui-signal)'
                                            : filledCount > 0 || isBusy
                                                ? 'var(--ui-signal-soft)'
                                                : 'var(--ui-hub-inner-stroke)'
                                }
                                className={styles.hubHalo}
                            />
                            {isConnected ? (
                                <path
                                    d="M 132 144.5 L 137.5 150 L 149 138.5"
                                    stroke="#ffffff"
                                    strokeWidth="2.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className={styles.checkDraw}
                                />
                            ) : (
                                <circle
                                    cx="140"
                                    cy="144"
                                    r="6"
                                    fill={ledColor}
                                    className={isConnecting ? styles.ledPulse : undefined}
                                />
                            )}

                            {/* 底部实体铭刻槽 */}
                            <rect x="124" y="177" width="32" height="3.5" rx="1.75" fill="var(--ui-hub-slot)"/>
                        </svg>
                    </div>

                    <div className={styles.stageCard}>
                        <span className={styles.statusIndicator}>
                            <span
                                className={[
                                    styles.statusDot,
                                    status === 'error'
                                        ? styles.statusDotError
                                        : isConnecting
                                            ? styles.statusDotConnecting
                                            : filledCount > 0 || isConnected
                                                ? styles.statusDotActive
                                                : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            />
                            <span>{statusCopy}</span>
                        </span>
                        <span className={styles.statusPips}>
                            {Array.from({length: PASSCODE_LENGTH}, (_, idx) => (
                                <span
                                    key={idx}
                                    className={[
                                        styles.statusPip,
                                        status === 'error'
                                            ? styles.statusPipError
                                            : idx < filledCount || isBusy
                                                ? styles.statusPipLit
                                                : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                />
                            ))}
                        </span>
                    </div>
                </div>
            </aside>
        </main>
    );
}
