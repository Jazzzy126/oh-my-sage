#!/usr/bin/env node
/**
 * 清理旧构建、执行 Next.js standalone 构建并打包为 oh-my-sage-web.tar.gz。
 *
 * 产物包含：
 *   - .next/standalone（含 server.js 与精简依赖，已解引用符号链接）
 *   - .next/static
 *   - public/（若存在）
 *   - .agents/（若存在）
 * 并排除 .env、.sessionstore、.git、node_modules/bufferutil。
 *
 * 用法：npm run build:web（或 node scripts/build-web-bundle.mjs）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const root = process.cwd();
const nextDir = path.join(root, '.next');
const bundleDir = path.join(root, '.deploy-bundle');
const archiveName = 'oh-my-sage-web.tar.gz';
const archivePath = path.join(root, archiveName);

// ==================== 1. 清理旧构建并执行 Next.js 构建 ====================

fs.rmSync(nextDir, { recursive: true, force: true });
execSync('npm run build', { cwd: root, stdio: 'inherit' });

const standaloneDir = path.join(nextDir, 'standalone');
const staticDir = path.join(nextDir, 'static');

if (!fs.existsSync(standaloneDir) || !fs.existsSync(staticDir)) {
    console.error('未找到 .next/standalone 或 .next/static，请确认 next.config 中已启用 output: "standalone"');
    process.exit(1);
}

// ==================== 2. 组装独立运行包并压缩 ====================

fs.rmSync(bundleDir, { recursive: true, force: true });

try {
    fs.cpSync(standaloneDir, bundleDir, { recursive: true, dereference: true });
    fs.cpSync(staticDir, path.join(bundleDir, '.next', 'static'), { recursive: true });

    for (const dir of ['public', '.agents']) {
        const src = path.join(root, dir);
        if (fs.existsSync(src)) {
            fs.cpSync(src, path.join(bundleDir, dir), { recursive: true });
        }
    }

    for (const rel of ['.env', '.sessionstore', '.git', path.join('node_modules', 'bufferutil')]) {
        fs.rmSync(path.join(bundleDir, rel), { recursive: true, force: true });
    }

    fs.rmSync(archivePath, { force: true });
    execFileSync('tar', ['-czf', archivePath, '-C', bundleDir, '.'], { cwd: root, stdio: 'inherit' });
} finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
}

const sizeMB = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(2);
console.log(`已生成 ${archiveName} (${sizeMB} MB)`);
