'use client';

import React, {useEffect, useId, useState} from 'react';
import {CloseOutlined} from '@ant-design/icons';
import styles from './SettingsModal.module.css';

export interface PublicRuntimeSettings {
    gatewayUrl: string;
    llmBaseUrl: string;
    llmModel: string;
    llmTemperature: number;
    hasApiKey: boolean;
    apiKeyMasked: string;
    gatewayConfigured: boolean;
    llmConfigured: boolean;
}

interface SettingsModalProps {
    open: boolean;
    onClose: () => void;
    onSaved?: (settings: PublicRuntimeSettings) => void;
}

export default function SettingsModal({open, onClose, onSaved}: SettingsModalProps) {
    const titleId = useId();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [gatewayUrl, setGatewayUrl] = useState('');
    const [llmBaseUrl, setLlmBaseUrl] = useState('');
    const [llmApiKey, setLlmApiKey] = useState('');
    const [llmModel, setLlmModel] = useState('');
    const [llmTemperature, setLlmTemperature] = useState('0.7');
    const [hasApiKey, setHasApiKey] = useState(false);
    const [apiKeyMasked, setApiKeyMasked] = useState('');
    const [clearApiKey, setClearApiKey] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setLlmApiKey('');
        setClearApiKey(false);

        fetch('/api/settings')
            .then(res => res.json())
            .then(result => {
                if (cancelled) return;
                if (result.success && result.settings) {
                    const s = result.settings as PublicRuntimeSettings;
                    setGatewayUrl(s.gatewayUrl || '');
                    setLlmBaseUrl(s.llmBaseUrl || '');
                    setLlmModel(s.llmModel || '');
                    setLlmTemperature(String(s.llmTemperature ?? 0.7));
                    setHasApiKey(Boolean(s.hasApiKey));
                    setApiKeyMasked(s.apiKeyMasked || '');
                } else {
                    setError(result.error || '加载配置失败');
                }
            })
            .catch(() => {
                if (!cancelled) setError('无法读取服务端配置');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !saving) onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open, saving, onClose]);

    if (!open) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving || loading) return;

        setSaving(true);
        setError(null);
        try {
            const payload: Record<string, unknown> = {
                gatewayUrl: gatewayUrl.trim(),
                llmBaseUrl: llmBaseUrl.trim(),
                llmModel: llmModel.trim(),
                llmTemperature: llmTemperature.trim() === '' ? 0.7 : Number(llmTemperature),
            };
            if (clearApiKey) {
                payload.clearApiKey = true;
            } else if (llmApiKey.trim()) {
                payload.llmApiKey = llmApiKey.trim();
            }

            const response = await fetch('/api/settings', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
            });
            const result = await response.json();
            if (!result.success) {
                setError(result.error || '保存配置失败');
                return;
            }
            onSaved?.(result.settings as PublicRuntimeSettings);
            onClose();
        } catch {
            setError('网络错误，保存配置失败');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className={styles.backdrop}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && !saving) onClose();
            }}
        >
            <div
                className={styles.modal}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <div className={styles.header}>
                    <div>
                        <h2 id={titleId} className={styles.title}>网关与 AI 模型配置</h2>
                        <p className={styles.subtitle}>
                            配置保存在服务端，一次设置后在其他电脑或浏览器打开都会自动复用。
                        </p>
                    </div>
                    <button
                        type="button"
                        className={styles.closeBtn}
                        onClick={onClose}
                        disabled={saving}
                        aria-label="关闭"
                    >
                        <CloseOutlined style={{fontSize: 13}}/>
                    </button>
                </div>

                <form className={styles.form} onSubmit={handleSubmit}>
                    <div className={styles.section}>
                        <div className={styles.sectionTitle}>米家中枢网关</div>
                        <div className={styles.field}>
                            <label className={styles.label} htmlFor="oms-gateway-url">
                                网关地址
                            </label>
                            <input
                                id="oms-gateway-url"
                                type="url"
                                className={styles.input}
                                placeholder="例如 http://192.168.0.5"
                                value={gatewayUrl}
                                disabled={loading || saving}
                                onChange={(e) => setGatewayUrl(e.target.value)}
                            />
                            <span className={styles.hint}>
                                局域网内中枢网关的 HTTP 地址，修改后下次连接网关时生效。
                            </span>
                        </div>
                    </div>

                    <div className={styles.section}>
                        <div className={styles.sectionTitle}>AI 模型（OpenAI 兼容接口）</div>

                        <div className={styles.field}>
                            <label className={styles.label} htmlFor="oms-llm-base-url">
                                API Base URL
                            </label>
                            <input
                                id="oms-llm-base-url"
                                type="url"
                                className={styles.input}
                                placeholder="例如 https://api.openai.com/v1"
                                value={llmBaseUrl}
                                disabled={loading || saving}
                                onChange={(e) => setLlmBaseUrl(e.target.value)}
                            />
                        </div>

                        <div className={styles.field}>
                            <div className={styles.labelRow}>
                                <label className={styles.label} htmlFor="oms-llm-api-key">
                                    API Key
                                </label>
                                {hasApiKey && !clearApiKey && (
                                    <button
                                        type="button"
                                        className={styles.clearLink}
                                        onClick={() => {
                                            setClearApiKey(true);
                                            setLlmApiKey('');
                                        }}
                                        disabled={loading || saving}
                                    >
                                        清除已保存的 Key
                                    </button>
                                )}
                            </div>
                            <input
                                id="oms-llm-api-key"
                                type="password"
                                autoComplete="off"
                                className={styles.input}
                                placeholder={
                                    clearApiKey
                                        ? '保存后将清除已有的 API Key'
                                        : hasApiKey
                                            ? `已配置 (${apiKeyMasked})，留空则保持不变`
                                            : '输入 API Key，例如 sk-...'
                                }
                                value={llmApiKey}
                                disabled={loading || saving}
                                onChange={(e) => {
                                    setLlmApiKey(e.target.value);
                                    if (clearApiKey && e.target.value.trim()) {
                                        setClearApiKey(false);
                                    }
                                }}
                            />
                        </div>

                        <div className={styles.inputRow}>
                            <div className={styles.field}>
                                <label className={styles.label} htmlFor="oms-llm-model">
                                    模型名称
                                </label>
                                <input
                                    id="oms-llm-model"
                                    type="text"
                                    className={styles.input}
                                    placeholder="例如 gpt-4o"
                                    value={llmModel}
                                    disabled={loading || saving}
                                    onChange={(e) => setLlmModel(e.target.value)}
                                />
                            </div>
                            <div className={styles.field}>
                                <label className={styles.label} htmlFor="oms-llm-temp">
                                    Temperature
                                </label>
                                <input
                                    id="oms-llm-temp"
                                    type="number"
                                    step="0.1"
                                    min="0"
                                    max="2"
                                    className={styles.input}
                                    placeholder="0.7"
                                    value={llmTemperature}
                                    disabled={loading || saving}
                                    onChange={(e) => setLlmTemperature(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {error && <div className={styles.errorBox} role="alert">{error}</div>}

                    <div className={styles.actions}>
                        <button
                            type="button"
                            className={styles.cancelButton}
                            onClick={onClose}
                            disabled={saving}
                        >
                            取消
                        </button>
                        <button
                            type="submit"
                            className={styles.saveButton}
                            disabled={loading || saving}
                        >
                            {saving ? '保存中…' : '保存配置'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
