'use client';

import React from 'react';
import ThemeProvider from '@/components/ThemeProvider';
import './globals.css';

const THEME_INIT_SCRIPT = `(function(){try{var k='oh-my-sage-theme';var s=localStorage.getItem(k);var t=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="zh-CN" suppressHydrationWarning>
        <head>
            <script dangerouslySetInnerHTML={{__html: THEME_INIT_SCRIPT}}/>
        </head>
        <body>
        <ThemeProvider>{children}</ThemeProvider>
        </body>
        </html>
    );
}
