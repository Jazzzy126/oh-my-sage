/**
 * Session 存储实现
 * 使用 JSONL 格式保存对话历史，索引采用内存缓存 + 异步串行落盘
 */

import fs from 'fs';
import {promises as fsp} from 'fs';
import path from 'path';

/**
 * Session 元数据
 */
export interface SessionMeta {
    id: string;
    title: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    isActive: boolean;
}

/**
 * Session 消息单步记录（保留多步 ReAct 真实因果序列）
 */
export interface SessionStep {
    /** 该步伴随工具调用的过渡说明文本 */
    text?: string;
    /** 原生推理模型的 reasoning 内容 */
    reasoning?: string;
    /** 该步发起并完成的工具调用列表 */
    toolCalls?: ToolCall[];
}

/**
 * 单轮对话 Token 与耗时统计
 */
export interface TurnUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    stepCount?: number;
}

/**
 * Session 消息
 */
export interface SessionMessage {
    seq: number;
    role: 'user' | 'assistant' | 'compressed';
    content: string;
    timestamp: string;
    thinking?: string;
    toolCalls?: ToolCall[];
    steps?: SessionStep[];
    usage?: TurnUsage;
}

/**
 * 工具调用记录
 */
export interface ToolCall {
    toolCallId?: string;  // Vercel AI SDK 的工具调用 ID
    tool: string;
    args: any;
    result: any;
    success: boolean;
}

/**
 * Session 索引
 */
interface SessionIndex {
    sessions: SessionMeta[];
}

/**
 * Session Store 类
 */
export class SessionStore {
    private baseDir: string;
    private dirReadyPromise: Promise<void> | null = null;
    private indexCache: SessionIndex | null = null;
    private indexLoadPromise: Promise<SessionIndex> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(baseDir: string = '.sessionstore') {
        this.baseDir = path.resolve(process.cwd(), baseDir);
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, {recursive: true});
        }
    }

    /**
     * 确保存储目录存在（异步幂等）
     */
    private async ensureDir(): Promise<void> {
        if (!this.dirReadyPromise) {
            this.dirReadyPromise = fsp.mkdir(this.baseDir, {recursive: true}).then(() => undefined);
        }
        return this.dirReadyPromise;
    }

    /**
     * 获取索引文件路径
     */
    private getIndexPath(): string {
        return path.join(this.baseDir, 'index.json');
    }

    /**
     * 校验 Session ID 合法性，防止路径穿越读写任意文件
     */
    public static isValidSessionId(sessionId: string): boolean {
        return typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId);
    }

    /**
     * 获取 Session 文件路径
     */
    private getSessionPath(sessionId: string): string {
        if (!SessionStore.isValidSessionId(sessionId)) {
            throw new Error(`非法的 Session ID: ${sessionId}`);
        }
        const resolved = path.resolve(this.baseDir, `${sessionId}.jsonl`);
        const rel = path.relative(this.baseDir, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Session 路径越界: ${sessionId}`);
        }
        return resolved;
    }

    /**
     * 读取索引（优先命中内存缓存，并发共享同一次磁盘加载）
     */
    private async readIndex(): Promise<SessionIndex> {
        if (this.indexCache) {
            return this.indexCache;
        }
        if (this.indexLoadPromise) {
            return this.indexLoadPromise;
        }
        this.indexLoadPromise = (async () => {
            await this.ensureDir();
            const indexPath = this.getIndexPath();
            try {
                const raw = await fsp.readFile(indexPath, 'utf8');
                const parsed = JSON.parse(raw) as SessionIndex;
                this.indexCache = Array.isArray(parsed?.sessions) ? parsed : {sessions: []};
            } catch {
                this.indexCache = {sessions: []};
            } finally {
                this.indexLoadPromise = null;
            }
            return this.indexCache;
        })();
        return this.indexLoadPromise;
    }

    /**
     * 写入索引（更新内存缓存并串行异步落盘，避免并发覆盖与事件循环阻塞）
     */
    private async writeIndex(index: SessionIndex): Promise<void> {
        this.indexCache = index;
        const payload = JSON.stringify(index);
        this.writeQueue = this.writeQueue.then(async () => {
            await this.ensureDir();
            await fsp.writeFile(this.getIndexPath(), payload, 'utf8');
        }).catch((err) => {
            console.error('写入 Session 索引失败:', err);
        });
        return this.writeQueue;
    }

    /**
     * 生成唯一 ID
     */
    private generateId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    /**
     * 创建新 Session
     */
    async createSession(title?: string): Promise<SessionMeta> {
        await this.ensureDir();
        const id = this.generateId();
        const now = new Date().toISOString();

        const meta: SessionMeta = {
            id,
            title: title || '新对话',
            summary: '',
            createdAt: now,
            updatedAt: now,
            messageCount: 0,
            isActive: true,
        };

        await fsp.writeFile(this.getSessionPath(id), '', 'utf8');

        const index = await this.readIndex();
        index.sessions.unshift(meta);
        await this.writeIndex(index);

        return meta;
    }

    /**
     * 获取 Session 列表
     */
    async listSessions(): Promise<SessionMeta[]> {
        const index = await this.readIndex();
        return [...index.sessions].sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
    }

    /**
     * 获取 Session 元数据
     */
    async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
        const index = await this.readIndex();
        return index.sessions.find(s => s.id === sessionId) || null;
    }

    /**
     * 获取 Session 消息历史
     */
    async getMessages(sessionId: string): Promise<SessionMessage[]> {
        const sessionPath = this.getSessionPath(sessionId);
        let content: string;
        try {
            content = await fsp.readFile(sessionPath, 'utf8');
        } catch {
            return [];
        }

        if (!content.trim()) {
            return [];
        }

        return content.trim().split('\n').map(line => {
            try {
                return JSON.parse(line) as SessionMessage;
            } catch {
                return null;
            }
        }).filter((msg): msg is SessionMessage => msg !== null);
    }

    /**
     * 追加消息
     */
    async appendMessage(sessionId: string, message: Omit<SessionMessage, 'seq'>): Promise<SessionMessage> {
        const messages = await this.getMessages(sessionId);
        const seq = messages.length;

        const fullMessage: SessionMessage = {
            ...message,
            seq,
        };

        await this.ensureDir();
        const sessionPath = this.getSessionPath(sessionId);
        await fsp.appendFile(sessionPath, JSON.stringify(fullMessage) + '\n', 'utf8');

        const index = await this.readIndex();
        const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex >= 0) {
            index.sessions[sessionIndex].messageCount = seq + 1;
            index.sessions[sessionIndex].updatedAt = new Date().toISOString();

            if (message.role === 'user') {
                index.sessions[sessionIndex].summary = message.content.substring(0, 100);
            }

            if (seq <= 1 && message.role === 'user') {
                index.sessions[sessionIndex].title = this.generateTitle(message.content);
            }

            await this.writeIndex(index);
        }

        return fullMessage;
    }

    /**
     * 生成干净可读的会话标题（剥离引用元数据后缀与常见口语前缀）
     */
    private generateTitle(content: string): string {
        let title = content
            .replace(/（(?:规则\s*)?ID:\s*[^）]+）/gi, '')
            .replace(/（DID:\s*[^）]+）/gi, '')
            .replace(/\((?:rule\s*)?id:\s*[^)]+\)/gi, '')
            .replace(/\(did:\s*[^)]+\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

        const prefixes = ['帮我', '请你帮我', '请帮我', '麻烦帮我', '请', '我想', '我要', '能否', '可以'];
        for (const prefix of prefixes) {
            if (title.startsWith(prefix)) {
                title = title.substring(prefix.length).trim();
                break;
            }
        }

        title = title.replace(/^[，,：:、\s]+|[：:，,。！？!?\s]+$/g, '');

        if (title.length > 22) {
            title = title.substring(0, 22) + '...';
        }

        return title || '新对话';
    }

    /**
     * 插入压缩摘要消息
     */
    async insertCompressedSummary(sessionId: string, summary: string): Promise<SessionMessage> {
        return this.appendMessage(sessionId, {
            role: 'compressed',
            content: summary,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * 截断 Session 消息
     */
    async truncateSession(sessionId: string, keepSeq: number): Promise<void> {
        const allMessages = await this.getMessages(sessionId);
        const keptMessages = allMessages.filter(m => m.seq <= keepSeq);

        const sessionPath = this.getSessionPath(sessionId);
        const content = keptMessages.map(m => JSON.stringify(m)).join('\n') + (keptMessages.length > 0 ? '\n' : '');
        await fsp.writeFile(sessionPath, content, 'utf8');

        const index = await this.readIndex();
        const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex >= 0) {
            index.sessions[sessionIndex].messageCount = keptMessages.length;
            index.sessions[sessionIndex].updatedAt = new Date().toISOString();
            const lastUserMsg = [...keptMessages].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                index.sessions[sessionIndex].summary = lastUserMsg.content.substring(0, 100);
            }
            await this.writeIndex(index);
        }
    }

    /**
     * 更新 Session 元数据
     */
    async updateSessionMeta(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
        const index = await this.readIndex();
        const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);

        if (sessionIndex >= 0) {
            index.sessions[sessionIndex] = {
                ...index.sessions[sessionIndex],
                ...updates,
                updatedAt: new Date().toISOString(),
            };
            await this.writeIndex(index);
        }
    }

    /**
     * 删除 Session
     */
    async deleteSession(sessionId: string): Promise<void> {
        const sessionPath = this.getSessionPath(sessionId);
        await fsp.unlink(sessionPath).catch(() => undefined);

        const index = await this.readIndex();
        index.sessions = index.sessions.filter(s => s.id !== sessionId);
        await this.writeIndex(index);
    }

    /**
     * 清空所有 Session
     */
    async clearAll(): Promise<void> {
        const index = await this.readIndex();
        await Promise.all(
            index.sessions.map(session =>
                fsp.unlink(this.getSessionPath(session.id)).catch(() => undefined)
            )
        );
        await this.writeIndex({sessions: []});
    }
}

// 全局单例
let storeInstance: SessionStore | null = null;

/**
 * 获取 Session Store 实例
 */
export function getSessionStore(): SessionStore {
    if (!storeInstance) {
        storeInstance = new SessionStore();
    }
    return storeInstance;
}
