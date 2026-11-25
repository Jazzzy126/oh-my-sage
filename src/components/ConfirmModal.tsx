'use client';

import React, {useEffect, useState, useId} from 'react';
import styles from './ConfirmModal.module.css';

export interface ConfirmModalProps {
    open: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
}

export default function ConfirmModal({
    open,
    title,
    description,
    confirmText = '确认',
    cancelText = '取消',
    danger = false,
    onConfirm,
    onCancel,
}: ConfirmModalProps) {
    const [submitting, setSubmitting] = useState(false);
    const titleId = useId();
    const descId = useId();

    useEffect(() => {
        if (!open) {
            setSubmitting(false);
            return;
        }
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !submitting) {
                onCancel();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, submitting, onCancel]);

    if (!open) return null;

    const handleConfirmClick = async () => {
        if (submitting) return;
        setSubmitting(true);
        try {
            await onConfirm();
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className={styles.backdrop}
            onClick={() => {
                if (!submitting) onCancel();
            }}
        >
            <div
                className={styles.modal}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descId : undefined}
                onClick={(e) => e.stopPropagation()}
            >
                <h3 id={titleId} className={styles.title}>
                    {title}
                </h3>
                {description && (
                    <p id={descId} className={styles.description}>
                        {description}
                    </p>
                )}
                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.cancelButton}
                        onClick={onCancel}
                        disabled={submitting}
                        autoFocus
                    >
                        {cancelText}
                    </button>
                    <button
                        type="button"
                        className={`${styles.confirmButton} ${danger ? styles.confirmDanger : ''}`}
                        onClick={handleConfirmClick}
                        disabled={submitting}
                    >
                        {submitting ? '处理中…' : confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
