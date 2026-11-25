'use client';

import React, {createContext, useContext, useEffect, useState, useCallback} from 'react';
import {ConfigProvider, App, theme as antdTheme} from 'antd';
import {SunOutlined, MoonOutlined} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import {StyleProvider} from '@ant-design/cssinjs';

export type ThemeMode = 'light' | 'dark';

interface ThemeContextValue {
    theme: ThemeMode;
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'oh-my-sage-theme';

const ThemeContext = createContext<ThemeContextValue>({
    theme: 'light',
    toggleTheme: () => {},
    setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
    return useContext(ThemeContext);
}

export function ThemeToggleButton({className}: {className?: string}) {
    const {theme, toggleTheme} = useTheme();
    const isDark = theme === 'dark';

    return (
        <button
            type="button"
            className={className}
            onClick={toggleTheme}
            aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
            title={isDark ? '切换到浅色模式' : '切换到深色模式'}
        >
            {isDark ? <SunOutlined style={{fontSize: 15}}/> : <MoonOutlined style={{fontSize: 15}}/>}
        </button>
    );
}

export default function ThemeProvider({children}: {children: React.ReactNode}) {
    const [theme, setThemeState] = useState<ThemeMode>('dark');

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(STORAGE_KEY);
            if (saved === 'light' || saved === 'dark') {
                setThemeState(saved);
                document.documentElement.dataset.theme = saved;
                return;
            }
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const initial: ThemeMode = prefersDark ? 'dark' : 'light';
            setThemeState(initial);
            document.documentElement.dataset.theme = initial;
        } catch {
            document.documentElement.dataset.theme = 'dark';
        }
    }, []);

    const setTheme = useCallback((mode: ThemeMode) => {
        setThemeState(mode);
        document.documentElement.dataset.theme = mode;
        try {
            window.localStorage.setItem(STORAGE_KEY, mode);
        } catch {
            // 忽略隐私模式存储限制
        }
    }, []);

    const toggleTheme = useCallback(() => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
    }, [theme, setTheme]);

    const isDark = theme === 'dark';

    return (
        <ThemeContext.Provider value={{theme, toggleTheme, setTheme}}>
            <StyleProvider hashPriority="high">
                <ConfigProvider
                    locale={zhCN}
                    theme={{
                        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
                        token: isDark
                            ? {
                                colorPrimary: '#5e6ad2',
                                colorInfo: '#5e6ad2',
                                colorSuccess: '#3fb984',
                                colorWarning: '#cfa055',
                                colorError: '#d96b6b',
                                borderRadius: 8,
                                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                                colorBgContainer: '#111113',
                                colorBgElevated: '#18181b',
                                colorBgLayout: '#0a0a0b',
                                colorText: '#ffffff',
                                colorTextSecondary: '#a1a1aa',
                                colorBorder: 'rgba(255, 255, 255, 0.1)',
                                colorBorderSecondary: 'rgba(255, 255, 255, 0.07)',
                            }
                            : {
                                colorPrimary: '#5e6ad2',
                                colorInfo: '#5e6ad2',
                                colorSuccess: '#249468',
                                colorWarning: '#c4832b',
                                colorError: '#cf4a4a',
                                borderRadius: 8,
                                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                                colorBgContainer: '#ffffff',
                                colorBgElevated: '#ffffff',
                                colorBgLayout: '#fafafa',
                                colorText: '#18181b',
                                colorTextSecondary: '#52525b',
                                colorBorder: 'rgba(0, 0, 0, 0.09)',
                                colorBorderSecondary: 'rgba(0, 0, 0, 0.06)',
                            },
                    }}
                >
                    <App>{children}</App>
                </ConfigProvider>
            </StyleProvider>
        </ThemeContext.Provider>
    );
}
