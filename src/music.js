/**
 * 音乐点歌模块：对接 ytmusic-bridge（搜索 + 下载），并按「会话 + 用户」隔离点歌状态。
 * 接入契约见 C:\project\test\youtube-music-api\docs\BOT-INTEGRATION.md
 */

import fsPromises from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';

export const MUSIC_AUDIO_FORMATS = Object.freeze(['mp3', 'm4a', 'opus']);
// 选歌命令末尾可选发送参数（只认最后一个独立单词）
export const MUSIC_TRAILING_FORMAT_TOKENS = Object.freeze(['mp3', 'm4a', 'opus', 'flac']);
export const MUSIC_TRAILING_MODE_TOKENS = Object.freeze(['file', 'voice']);
export const MUSIC_TRAILING_PARAM_TOKENS = Object.freeze([
    ...MUSIC_TRAILING_FORMAT_TOKENS,
    ...MUSIC_TRAILING_MODE_TOKENS
]);
// 末尾独立词：前面必须有正文，避免把单独的 "mp3" 搜索词误吃掉
const MUSIC_TRAILING_PARAM_RE = new RegExp(
    '^(?<body>[\\s\\S]*?\\S)\\s+(?<token>' + MUSIC_TRAILING_PARAM_TOKENS.join('|') + ')$',
    'i'
);
export const DEFAULT_MUSIC_BASE_URL = 'http://127.0.0.1:8787';
export const DEFAULT_MUSIC_COMMAND = '/music';
export const DEFAULT_MUSIC_EXIT_COMMAND = '/music-exit';
export const DEFAULT_VOICE_SEGMENT_SECONDS = 120;
export const DEFAULT_FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const FULL_WIDTH_DIGITS = /[\uFF10-\uFF19]/g;

function sanitizeText(value) {
    return String(value ?? '').trim();
}

/**
 * 去掉指令前的 @bot / CQ at / 裸 @昵称，避免「@机器人 /music 9」或系统插入的提及前缀导致点歌指令匹配失败、消息漏给 AI。
 */
export function stripLeadingMentionsForCommand(text = '') {
    let normalized = sanitizeText(text);
    if (!normalized) {
        return '';
    }

    let previous = '';
    while (normalized && normalized !== previous) {
        previous = normalized;
        normalized = normalized
            .replace(/^\[@bot\]\s*/i, '')
            .replace(/^\[@[^\]]*\]\s*/u, '')
            .replace(/^\[CQ:at,[^\]]*\]\s*/i, '')
            .replace(/^@\S+\s+/u, '')
            .trim();
    }

    return normalized;
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function defaultRunCommand(command, args = [], { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`命令超时: ${command}`));
        }, timeoutMs);
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 4000) {
                stderr = stderr.slice(-4000);
            }
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} 退出码 ${code}: ${stderr.trim() || 'unknown error'}`));
        });
    });
}

function clampFloat(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, normalized));
}

function normalizeCommandText(value, fallback) {
    const normalized = sanitizeText(value);
    if (!normalized || /\s/.test(normalized)) {
        return fallback;
    }
    return normalized;
}

/** 归一化音乐配置，所有字段都有安全默认值，便于前端与运行时共用 */
export function normalizeMusicConfig(raw = {}) {
    const format = String(raw.format || 'mp3').toLowerCase();
    return {
        enabled: raw.enabled === true,
        command: normalizeCommandText(raw.command, DEFAULT_MUSIC_COMMAND),
        exitCommand: normalizeCommandText(raw.exitCommand, DEFAULT_MUSIC_EXIT_COMMAND),
        baseUrl: sanitizeText(raw.baseUrl) || DEFAULT_MUSIC_BASE_URL,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        limit: clampInteger(raw.limit, 1, 20, 10),
        minScore: clampFloat(raw.minScore, 0, 1, 0.35),
        searchTimeoutMs: clampInteger(raw.searchTimeoutMs, 1000, 120000, 20000),
        downloadTimeoutMs: clampInteger(raw.downloadTimeoutMs, 5000, 600000, 300000),
        sessionTtlMs: clampInteger(raw.sessionTtlMs, 60000, 3600000, 1800000),
        maxDurationSeconds: clampInteger(raw.maxDurationSeconds, 0, 7200, 900),
        // QQ 语音单条约 2 分钟；默认 120 秒切段连发，0 表示不切段
        voiceSegmentSeconds: clampInteger(raw.voiceSegmentSeconds, 0, 600, DEFAULT_VOICE_SEGMENT_SECONDS),
        maxFilesizeMB: clampInteger(raw.maxFilesizeMB, 1, 200, 30),
        format: MUSIC_AUDIO_FORMATS.includes(format) ? format : 'mp3'
    };
}

/**
 * 点歌状态的隔离键：群聊按「群 + 用户」隔离，私聊按用户隔离。
 * 保证同一个群里多人同时点歌互不串台。
 */
export function buildMusicSessionKey(event = {}) {
    const userId = sanitizeText(event.user_id);
    if (event.message_type === 'group') {
        return `group:${sanitizeText(event.group_id)}:user:${userId}`;
    }
    return `private:${userId}`;
}

function normalizeDigits(text) {
    return text.replace(FULL_WIDTH_DIGITS, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

function normalizeNameForMatch(text) {
    return sanitizeText(text).replace(/\s+/g, ' ').toLowerCase();
}

function matchesCommandPrefix(text, command) {
    if (text === command) {
        return true;
    }
    if (!text.startsWith(command)) {
        return false;
    }
    const nextChar = text.slice(command.length, command.length + 1);
    return /\s/.test(nextChar);
}

/**
 * 解析音乐指令。
 * - `/music-exit` → 退出点歌状态
 * - `/music 关键词` → 新搜索
 * - 已有候选列表时 `/music 3` / `/music 晴天 - 周杰伦` → 选歌
 */

/**
 * 剥离选歌/搜索参数末尾的发送方式词。
 * 规则：只认最后一个独立单词，且必须命中白名单；歌名中间的 mp3/flac 等不处理。
 * 例：
 * - "1 mp3" -> body=1, file/mp3
 * - "Scream Aim Fire flac" -> body=Scream Aim Fire, file/flac
 * - "song mp3 live" -> 不剥离（mp3 不是最后一词）
 * - "mp3" -> 不剥离（没有前置正文，当作普通关键词）
 */
export function splitMusicTrailingParam(argument = '') {
    const text = sanitizeText(argument);
    if (!text) {
        return {
            body: '',
            deliveryMode: 'voice',
            format: null,
            trailingToken: null
        };
    }

    const matched = text.match(MUSIC_TRAILING_PARAM_RE);
    if (!matched?.groups?.body || !matched?.groups?.token) {
        return {
            body: text,
            deliveryMode: 'voice',
            format: null,
            trailingToken: null
        };
    }

    const token = String(matched.groups.token).toLowerCase();
    const body = sanitizeText(matched.groups.body);
    if (!body) {
        return {
            body: text,
            deliveryMode: 'voice',
            format: null,
            trailingToken: null
        };
    }

    if (token === 'voice') {
        return {
            body,
            deliveryMode: 'voice',
            format: null,
            trailingToken: token
        };
    }

    if (token === 'file') {
        return {
            body,
            deliveryMode: 'file',
            format: null,
            trailingToken: token
        };
    }

    // mp3/m4a/opus/flac => 文件发送 + 指定格式
    return {
        body,
        deliveryMode: 'file',
        format: token,
        trailingToken: token
    };
}


/**
 * 按 BOT-PARAMS 约定，把用户尾参映射成 API /download 的 format。
 * - 默认/voice => delivery=voice, format=opus
 * - file => delivery=file, format=mp3
 * - mp3/m4a/opus => delivery=file, format=对应值
 * - flac => 不调 API，提示暂不支持
 * voice/file 本身不是音频容器，不能原样传给上游。
 */
export function resolveMusicDownloadFormat(parsed = {}, config = {}) {
    const deliveryMode = parsed?.deliveryMode === 'file' ? 'file' : 'voice';
    const token = String(parsed?.format || parsed?.trailingToken || '').toLowerCase();

    if (token === 'flac') {
        return {
            ok: false,
            deliveryMode: 'file',
            format: 'flac',
            reason: 'unsupported_format',
            message: '暂不支持 flac，请改用 mp3 / m4a / opus'
        };
    }

    if (deliveryMode === 'voice') {
        return {
            ok: true,
            deliveryMode: 'voice',
            // 语音消息更适合 opus；显式传给 /download，不依赖服务端默认 mp3
            format: 'opus'
        };
    }

    if (token === 'mp3' || token === 'm4a' || token === 'opus') {
        return {
            ok: true,
            deliveryMode: 'file',
            format: token
        };
    }

    // 仅 file、或未带具体编码时
    return {
        ok: true,
        deliveryMode: 'file',
        format: 'mp3'
    };
}

export function parseMusicCommand(plainText = '', {
    command = DEFAULT_MUSIC_COMMAND,
    exitCommand = DEFAULT_MUSIC_EXIT_COMMAND,
    session = null
} = {}) {
    const normalizedText = stripLeadingMentionsForCommand(plainText);
    const normalizedCommand = normalizeCommandText(command, DEFAULT_MUSIC_COMMAND);
    const normalizedExitCommand = normalizeCommandText(exitCommand, DEFAULT_MUSIC_EXIT_COMMAND);

    if (!normalizedText) {
        return { type: 'none' };
    }

    // 退出指令必须先判断：/music-exit 与 /music 前缀相似，顺序反了会被误判
    if (matchesCommandPrefix(normalizedText, normalizedExitCommand)) {
        return { type: 'exit' };
    }

    if (!matchesCommandPrefix(normalizedText, normalizedCommand)) {
        return { type: 'none' };
    }

    const argument = sanitizeText(normalizedText.slice(normalizedCommand.length));
    if (!argument) {
        return { type: 'usage' };
    }

    // 只认最后一个单词作为发送参数；剥离后再做选歌/搜索判断，避免空格歌名被误伤
    const trailing = splitMusicTrailingParam(argument);
    const body = trailing.body;
    if (!body) {
        return { type: 'usage' };
    }

    const delivery = {
        deliveryMode: trailing.deliveryMode,
        format: trailing.format,
        trailingToken: trailing.trailingToken
    };

    const results = Array.isArray(session?.results) ? session.results : [];
    if (results.length > 0) {
        const numericArgument = normalizeDigits(body);
        if (/^\d+$/.test(numericArgument)) {
            return {
                type: 'select',
                index: Number.parseInt(numericArgument, 10),
                raw: body,
                ...delivery
            };
        }

        const wanted = normalizeNameForMatch(body);
        const matched = results.find((item) => normalizeNameForMatch(item?.display_name) === wanted);
        if (matched) {
            return {
                type: 'select',
                name: sanitizeText(matched.display_name),
                raw: body,
                ...delivery
            };
        }
    }

    return {
        type: 'search',
        query: body,
        ...delivery
    };
}

function formatDuration(result = {}) {
    const text = sanitizeText(result.duration);
    if (text) {
        return text;
    }
    const seconds = Number(result.duration_seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return '';
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/** 渲染候选歌单文本 */
export function formatMusicSearchList(query, results = [], {
    command = DEFAULT_MUSIC_COMMAND,
    exitCommand = DEFAULT_MUSIC_EXIT_COMMAND,
    expiresInSeconds = 1800,
    truncated = false
} = {}) {
    const lines = results.map((result) => {
        const duration = formatDuration(result);
        const durationText = duration ? `（${duration}）` : '';
        return `${result.index}. ${sanitizeText(result.display_name)}${durationText}`;
    });
    const minutes = Math.max(1, Math.round(Number(expiresInSeconds) / 60) || 1);
    const header = `🎵 「${sanitizeText(query)}」的搜索结果（${results.length} 条${truncated ? '，上游还有更多' : ''}）`;
    const footer = [
        `回复 ${command} 序号 选歌，例如 ${command} 1（默认语音；末尾加 mp3 可发文件）`,
        `也可以回复 ${command} 完整歌名`,
        `选错了可重发序号；退出请发 ${exitCommand}`,
        `${minutes} 分钟内有效`
    ].join('\n');
    return `${header}\n${lines.join('\n')}\n${footer}`;
}

function decodeHeaderValue(value) {
    const raw = sanitizeText(value);
    if (!raw) {
        return '';
    }
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export class MusicBridgeError extends Error {
    constructor(message, { status = 0, code = '', detail = null, retryable = false } = {}) {
        super(message);
        this.name = 'MusicBridgeError';
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.retryable = retryable;
    }
}

const RETRYABLE_STATUS = new Set([429, 502, 504]);

function buildUserFacingBridgeMessage(error, { command, exitCommand }) {
    if (!(error instanceof MusicBridgeError)) {
        return `点歌失败：${error.message}`;
    }

    switch (error.code) {
        case 'SESSION_EXPIRED':
            return `点歌候选已过期，请重新发送 ${command} 歌名 搜索`;
        case 'AMBIGUOUS_NAME': {
            const candidates = Array.isArray(error.detail?.candidates)
                ? error.detail.candidates
                : Array.isArray(error.detail)
                    ? error.detail
                    : [];
            const hint = candidates
                .map((item) => (typeof item === 'string' ? item : `${item?.index ?? ''}. ${item?.display_name ?? ''}`.trim()))
                .filter(Boolean)
                .slice(0, 10)
                .join('\n');
            return hint
                ? `歌名匹配到多首同名歌曲，请改用序号：\n${hint}`
                : '歌名匹配到多首同名歌曲，请改用序号选歌';
        }
        case 'NOT_FOUND':
            return '没找到这首候选（序号越界或歌名不匹配），请重新选一次';
        case 'FILE_TOO_LARGE':
            return '这首歌文件太大，QQ 语音发不出去，换一首试试';
        case 'RATE_LIMITED':
            return '点歌服务正在忙（下载排队已满），稍后再试一次';
        case 'UNAUTHORIZED':
            return '点歌服务鉴权失败，请管理员检查音乐桥接的 API Key';
        case 'INVALID_REQUEST':
            return `点歌参数不对：${error.message}`;
        case 'UPSTREAM_ERROR':
            return '上游 YouTube Music 解析失败，稍后再试';
        case 'TIMEOUT':
            return '点歌服务响应超时，稍后再试';
        default:
            break;
    }

    if (error.code === 'SERVICE_UNAVAILABLE') {
        return `点歌服务连不上（${error.message}），请管理员检查 ytmusic-bridge 是否启动。退出点歌可发 ${exitCommand}`;
    }

    return `点歌失败：${error.message}`;
}

/** ytmusic-bridge HTTP 客户端 */
export class MusicBridgeClient {
    constructor({ getConfig, fetchImpl = globalThis.fetch, logger = console } = {}) {
        this.getConfig = typeof getConfig === 'function' ? getConfig : () => normalizeMusicConfig({});
        this.fetchImpl = fetchImpl;
        this.logger = logger;
    }

    buildUrl(pathname, config) {
        const base = config.baseUrl.replace(/\/+$/, '');
        return `${base}${pathname}`;
    }

    buildHeaders(config) {
        const headers = { 'Content-Type': 'application/json; charset=utf-8' };
        if (config.apiKey) {
            headers['X-API-Key'] = config.apiKey;
        }
        return headers;
    }

    async request(pathname, { body, timeoutMs, config }) {
        let response;
        try {
            response = await this.fetchImpl(this.buildUrl(pathname, config), {
                method: 'POST',
                headers: this.buildHeaders(config),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
            throw new MusicBridgeError(
                isTimeout ? `请求超时（${timeoutMs}ms）` : (error?.message || '网络请求失败'),
                { code: isTimeout ? 'TIMEOUT' : 'SERVICE_UNAVAILABLE', retryable: isTimeout }
            );
        }

        if (!response.ok) {
            throw await this.buildErrorFromResponse(response);
        }

        return response;
    }

    async buildErrorFromResponse(response) {
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        const code = sanitizeText(payload?.code) || `HTTP_${response.status}`;
        const message = sanitizeText(payload?.message) || `HTTP ${response.status}`;
        return new MusicBridgeError(message, {
            status: response.status,
            code,
            detail: payload?.detail ?? null,
            retryable: RETRYABLE_STATUS.has(response.status)
        });
    }

    async withRetry(operation) {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof MusicBridgeError && error.retryable) {
                this.logger?.warn?.(`[点歌] 上游可重试错误，重试一次: ${error.code} ${error.message}`);
                return operation();
            }
            throw error;
        }
    }

    async healthz() {
        const config = normalizeMusicConfig(this.getConfig());
        const response = await this.fetchImpl(this.buildUrl('/healthz', config), {
            method: 'GET',
            headers: this.buildHeaders(config),
            signal: AbortSignal.timeout(Math.min(config.searchTimeoutMs, 10000))
        });
        if (!response.ok) {
            throw await this.buildErrorFromResponse(response);
        }
        return response.json();
    }

    async search(query) {
        const config = normalizeMusicConfig(this.getConfig());
        const response = await this.withRetry(() => this.request('/search', {
            body: { query, limit: config.limit, min_score: config.minScore },
            timeoutMs: config.searchTimeoutMs,
            config
        }));
        return response.json();
    }

    async download({ sessionId = '', index = null, name = '', videoId = '', format = '' } = {}) {
        const config = normalizeMusicConfig(this.getConfig());
        const requestedFormat = String(format || config.format || 'mp3').toLowerCase();
        if (requestedFormat === 'flac') {
            throw new MusicBridgeError('暂不支持 flac，请改用 mp3 / m4a / opus', {
                code: 'INVALID_REQUEST',
                status: 400
            });
        }
        const body = {
            format: MUSIC_AUDIO_FORMATS.includes(requestedFormat) ? requestedFormat : config.format
        };
        if (videoId) {
            body.video_id = videoId;
        } else if (Number.isInteger(index)) {
            body.session_id = sessionId;
            body.index = index;
        } else if (name) {
            body.session_id = sessionId;
            body.name = name;
        } else {
            throw new MusicBridgeError('缺少选歌方式（video_id / index / name）', { code: 'INVALID_REQUEST' });
        }

        const response = await this.withRetry(() => this.request('/download', {
            body,
            timeoutMs: config.downloadTimeoutMs,
            config
        }));

        const maxBytes = config.maxFilesizeMB * 1024 * 1024;
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            await response.body?.cancel?.().catch?.(() => {});
            throw new MusicBridgeError(
                `音频 ${(contentLength / 1024 / 1024).toFixed(1)}MB 超过上限 ${config.maxFilesizeMB}MB`,
                { code: 'FILE_TOO_LARGE', status: 413 }
            );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) {
            throw new MusicBridgeError(
                `音频 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${config.maxFilesizeMB}MB`,
                { code: 'FILE_TOO_LARGE', status: 413 }
            );
        }

        // 必须以本次实际请求/响应格式为准，不能回写成全局 config.format
        // 否则 voice 默认拉 opus 却落成 .mp3，ffmpeg -c copy 切段会直接失败
        const actualFormat = MUSIC_AUDIO_FORMATS.includes(String(body.format || '').toLowerCase())
            ? String(body.format).toLowerCase()
            : (MUSIC_AUDIO_FORMATS.includes(String(config.format || '').toLowerCase()) ? String(config.format).toLowerCase() : 'mp3');
        return {
            buffer,
            format: actualFormat,
            title: decodeHeaderValue(response.headers?.get?.('x-track-title')),
            artists: decodeHeaderValue(response.headers?.get?.('x-track-artists')),
            videoId: sanitizeText(response.headers?.get?.('x-track-video-id')),
            durationSeconds: Number(response.headers?.get?.('x-track-duration')) || 0,
            cacheHit: sanitizeText(response.headers?.get?.('x-cache')) === 'hit'
        };
    }
}

/**
 * 点歌会话存储：按「群+用户 / 私聊用户」隔离候选列表，并为每个用户加下载并发锁。
 * 不使用全局变量保存 session_id，避免多人同时点歌互相串台。
 */
export class MusicSessionStore {
    constructor({ now = () => Date.now(), maxSessions = 500 } = {}) {
        this.now = now;
        this.maxSessions = maxSessions;
        this.sessions = new Map();
        this.activeDownloads = new Set();
    }

    prune() {
        const current = this.now();
        for (const [key, session] of this.sessions) {
            if (session.expiresAt <= current) {
                this.sessions.delete(key);
            }
        }
        while (this.sessions.size > this.maxSessions) {
            const oldestKey = this.sessions.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.sessions.delete(oldestKey);
        }
    }

    get(key) {
        const session = this.sessions.get(key);
        if (!session) {
            return null;
        }
        if (session.expiresAt <= this.now()) {
            this.sessions.delete(key);
            return null;
        }
        return session;
    }

    set(key, { sessionId, query, results, ttlMs }) {
        this.prune();
        // 重新 set 时先删除，保证 Map 迭代顺序等于最近活跃顺序
        this.sessions.delete(key);
        this.sessions.set(key, {
            sessionId,
            query,
            results,
            createdAt: this.now(),
            expiresAt: this.now() + ttlMs
        });
        return this.sessions.get(key);
    }

    delete(key) {
        return this.sessions.delete(key);
    }

    isDownloading(key) {
        return this.activeDownloads.has(key);
    }

    acquireDownload(key) {
        if (this.activeDownloads.has(key)) {
            return false;
        }
        this.activeDownloads.add(key);
        return true;
    }

    releaseDownload(key) {
        this.activeDownloads.delete(key);
    }

    getStats() {
        this.prune();
        return {
            sessions: this.sessions.size,
            activeDownloads: this.activeDownloads.size
        };
    }
}

function buildMusicFileName(track = {}, fallbackName = '', format = 'mp3') {
    const base = sanitizeText(track.display_name || track.title || fallbackName || 'track')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 80) || 'track';
    const ext = sanitizeText(format || track.format || 'mp3').toLowerCase() || 'mp3';
    return `${base}.${ext}`;
}

function buildTrackLabel(track = {}, fallback = '') {
    const title = sanitizeText(track.title);
    const artists = sanitizeText(track.artists);
    if (title && artists) {
        return `${title} - ${artists}`;
    }
    return title || sanitizeText(fallback) || '未知曲目';
}

/**
 * 音乐指令处理器：把解析、上游调用、状态隔离、语音下发串起来。
 * 发送动作通过 sendText / sendVoice 注入，便于测试与复用群聊 / 私聊差异。
 */
export class MusicCommandHandler {
    constructor({
        getConfig,
        client,
        store = new MusicSessionStore(),
        logger = console,
        audioDir,
        fileSystem = fsPromises,
        // 可注入，便于单测模拟切段；默认用系统 ffmpeg
        runCommand = null,
        ffmpegPath = DEFAULT_FFMPEG_PATH
    } = {}) {
        this.getConfig = typeof getConfig === 'function' ? getConfig : () => normalizeMusicConfig({});
        this.client = client || new MusicBridgeClient({ getConfig: this.getConfig, logger });
        this.store = store;
        this.logger = logger;
        this.audioDir = audioDir;
        this.fileSystem = fileSystem;
        this.runCommand = typeof runCommand === 'function' ? runCommand : defaultRunCommand;
        this.ffmpegPath = ffmpegPath || DEFAULT_FFMPEG_PATH;
    }

    getNormalizedConfig() {
        return normalizeMusicConfig(this.getConfig());
    }

    async handle({ event = {}, plainText = '', sendText, sendVoice, sendFile, onCommandAccepted } = {}) {
        const config = this.getNormalizedConfig();
        const sessionKey = buildMusicSessionKey(event);
        const session = this.store.get(sessionKey);
        const parsed = parseMusicCommand(plainText, {
            command: config.command,
            exitCommand: config.exitCommand,
            session
        });

        if (parsed.type === 'none') {
            return { handled: false, ok: false, reason: 'not_command' };
        }

        const reply = async (text) => {
            if (typeof sendText === 'function') {
                await sendText(text);
            }
        };

        if (config.enabled !== true) {
            // 已识别为点歌指令时必须拦截，不能再交给 LLM，否则会出现 AI 把 /music 9 当聊天并 @发送者
            await reply(`点歌功能未启用。请管理员在配置里打开「启用点歌指令」，并填写音乐 API 地址（${config.baseUrl || DEFAULT_MUSIC_BASE_URL}）`);
            return { handled: true, ok: false, reason: 'disabled', sessionKey };
        }

        if (typeof onCommandAccepted === 'function') {
            onCommandAccepted();
        }

        if (parsed.type === 'exit') {
            const existed = this.store.delete(sessionKey);
            await reply(existed
                ? '已退出点歌状态，候选列表已清空'
                : '当前没有进行中的点歌状态');
            return { handled: true, ok: true, reason: 'exit', sessionKey, hadSession: existed };
        }

        if (parsed.type === 'usage') {
            await reply([
                `🎵 点歌用法：`,
                `${config.command} 歌名 关键词 —— 搜索歌曲`,
                `${config.command} 序号 或 ${config.command} 完整歌名 —— 选歌（默认语音）`,
                `${config.command} 序号 mp3/m4a/opus/file —— 选歌并发送文件`,
                `选错了可重发序号/歌名；退出请发 ${config.exitCommand}`
            ].join('\n'));
            return { handled: true, ok: true, reason: 'usage', sessionKey };
        }

        if (parsed.type === 'search') {
            return this.handleSearch({ config, sessionKey, query: parsed.query, reply });
        }

        return this.handleSelect({ config, sessionKey, session, parsed, reply, sendVoice, sendFile });
    }

    async handleSearch({ config, sessionKey, query, reply }) {
        try {
            await reply(`🔍 正在搜索「${query}」，请稍等`);
            const payload = await this.client.search(query);
            const results = Array.isArray(payload?.results) ? payload.results : [];
            if (results.length === 0 || !payload?.session_id) {
                this.store.delete(sessionKey);
                await reply(`没搜到「${query}」，换个关键词或加上歌手名再试试`);
                return { handled: true, ok: false, reason: 'empty_result', sessionKey };
            }

            const ttlMs = Number.isFinite(Number(payload.expires_in)) && Number(payload.expires_in) > 0
                ? Math.min(Number(payload.expires_in) * 1000, config.sessionTtlMs)
                : config.sessionTtlMs;
            this.store.set(sessionKey, {
                sessionId: String(payload.session_id),
                query,
                results,
                ttlMs
            });

            await reply(formatMusicSearchList(query, results, {
                command: config.command,
                exitCommand: config.exitCommand,
                expiresInSeconds: Math.round(ttlMs / 1000),
                truncated: payload.truncated === true
            }));
            this.logger?.info?.('[点歌] 搜索完成', {
                sessionKey,
                query,
                total: results.length,
                bridgeSessionId: String(payload.session_id)
            });
            return { handled: true, ok: true, reason: 'search', sessionKey, total: results.length };
        } catch (error) {
            this.logger?.warn?.(`[点歌] 搜索失败: ${sessionKey} ${error.code || ''} ${error.message}`);
            await reply(`⚠️ ${buildUserFacingBridgeMessage(error, config)}`);
            return { handled: true, ok: false, reason: 'search_failed', sessionKey, error: error.message };
        }
    }

    async handleSelect({ config, sessionKey, session, parsed, reply, sendVoice, sendFile }) {
        if (!session) {
            await reply(`当前没有候选歌单，请先发送 ${config.command} 歌名 搜索`);
            return { handled: true, ok: false, reason: 'no_session', sessionKey };
        }

        const results = session.results;
        let picked = null;
        if (Number.isInteger(parsed.index)) {
            picked = results.find((item) => Number(item?.index) === parsed.index) || null;
            if (!picked) {
                await reply(`序号 ${parsed.index} 不在候选里，请选 1 - ${results.length}。选错了可重发序号，或发 ${config.exitCommand} 退出`);
                return { handled: true, ok: false, reason: 'index_out_of_range', sessionKey };
            }
        } else {
            picked = results.find((item) => normalizeNameForMatch(item?.display_name) === normalizeNameForMatch(parsed.name)) || null;
            if (!picked) {
                await reply(`候选里没有「${parsed.name}」，请改用序号选歌。选错了可重发正确序号，或发 ${config.exitCommand} 退出`);
                return { handled: true, ok: false, reason: 'name_not_found', sessionKey };
            }
        }

        if (config.maxDurationSeconds > 0) {
            const duration = Number(picked.duration_seconds) || 0;
            if (duration > config.maxDurationSeconds) {
                await reply(`「${picked.display_name}」时长 ${formatDuration(picked) || `${duration}s`} 超过上限 ${Math.floor(config.maxDurationSeconds / 60)} 分钟，换一首吧`);
                return { handled: true, ok: false, reason: 'too_long', sessionKey };
            }
        }

        // 同一用户同时只允许一个下载任务，避免单人刷指令把桥接服务排队占满
        if (!this.store.acquireDownload(sessionKey)) {
            await reply('你上一首还在下载中，等这首发出来再点下一首');
            return { handled: true, ok: false, reason: 'user_busy', sessionKey };
        }
        const createdPaths = [];
        try {
            const resolved = resolveMusicDownloadFormat(parsed, config);
            const deliveryMode = resolved.deliveryMode;
            const requestFormat = resolved.format;

            if (!resolved.ok) {
                await reply(resolved.message || '暂不支持该音频格式，请改用 mp3 / m4a / opus');
                return {
                    handled: true,
                    ok: false,
                    reason: resolved.reason || 'unsupported_format',
                    sessionKey,
                    format: resolved.format || null,
                    deliveryMode
                };
            }

            const segmentSeconds = Number(config.voiceSegmentSeconds) || 0;
            const durationHint = Number(picked.duration_seconds) || 0;
            const estimatedParts = deliveryMode === 'voice' && segmentSeconds > 0 && durationHint > 0
                ? Math.max(1, Math.ceil(durationHint / segmentSeconds))
                : 1;

            if (deliveryMode === 'file') {
                await reply(`📁 正在下载「${picked.display_name}」并按文件发送（${String(requestFormat).toLowerCase()}），请稍等`);
            } else {
                await reply(estimatedParts > 1
                    ? `🎵 正在下载「${picked.display_name}」，约 ${estimatedParts} 段语音连发，请稍等`
                    : `🎵 正在下载「${picked.display_name}」，转成语音后发出来，请稍等`);
            }

            const track = await this.client.download({
                sessionId: session.sessionId,
                index: Number.isInteger(parsed.index) ? parsed.index : null,
                name: Number.isInteger(parsed.index) ? '' : parsed.name,
                format: requestFormat
            });
            const audioPath = await this.writeAudioFile(track);
            createdPaths.push(audioPath);

            if (deliveryMode === 'file') {
                if (typeof sendFile !== 'function') {
                    throw new Error('当前会话不支持发送文件');
                }
                const fileName = buildMusicFileName(track, picked.display_name, track.format || requestFormat);
                await sendFile(audioPath, {
                    track,
                    label: buildTrackLabel(track, picked.display_name),
                    picked,
                    fileName,
                    format: track.format || requestFormat,
                    deliveryMode: 'file'
                });
                this.logger?.info?.('[点歌] 文件已发送', {
                    sessionKey,
                    videoId: track.videoId || picked.video_id || '',
                    bytes: track.buffer.length,
                    cacheHit: track.cacheHit,
                    format: track.format || requestFormat,
                    deliveryMode: 'file'
                });
                return {
                    handled: true,
                    ok: true,
                    reason: 'sent_file',
                    sessionKey,
                    videoId: track.videoId || picked.video_id || '',
                    bytes: track.buffer.length,
                    parts: 1,
                    deliveryMode: 'file',
                    format: track.format || requestFormat
                };
            }

            if (typeof sendVoice !== 'function') {
                throw new Error('当前会话不支持发送语音');
            }

            // QQ 语音单条约 2 分钟：超过 voiceSegmentSeconds 时切段顺序连发
            const segmentPaths = await this.splitAudioForVoice(audioPath, {
                format: track.format || config.format,
                segmentSeconds,
                durationSeconds: Number(track.durationSeconds) || durationHint
            });
            for (const segmentPath of segmentPaths) {
                if (!createdPaths.includes(segmentPath)) {
                    createdPaths.push(segmentPath);
                }
            }

            const totalParts = segmentPaths.length;
            for (let index = 0; index < segmentPaths.length; index += 1) {
                const segmentPath = segmentPaths[index];
                const part = index + 1;
                await sendVoice(segmentPath, {
                    track,
                    label: buildTrackLabel(track, picked.display_name),
                    picked,
                    part,
                    totalParts,
                    segmentSeconds,
                    deliveryMode: 'voice'
                });
                if (totalParts > 1 && part < totalParts) {
                    await sleep(350);
                }
            }

            if (totalParts > 1) {
                await reply(`✅ 「${picked.display_name}」已分 ${totalParts} 段发完`);
            }

            this.logger?.info?.('[点歌] 语音已发送', {
                sessionKey,
                videoId: track.videoId || picked.video_id || '',
                bytes: track.buffer.length,
                cacheHit: track.cacheHit,
                parts: totalParts,
                segmentSeconds,
                deliveryMode: 'voice'
            });
            return {
                handled: true,
                ok: true,
                reason: 'sent',
                sessionKey,
                videoId: track.videoId || picked.video_id || '',
                bytes: track.buffer.length,
                parts: totalParts,
                deliveryMode: 'voice'
            };
        } catch (error) {
            this.logger?.warn?.(`[点歌] 选歌失败: ${sessionKey} ${error.code || ''} ${error.message}`);
            if (error instanceof MusicBridgeError && error.code === 'SESSION_EXPIRED') {
                this.store.delete(sessionKey);
            }
            await reply(`⚠️ ${buildUserFacingBridgeMessage(error, config)}`);
            return { handled: true, ok: false, reason: 'download_failed', sessionKey, error: error.message };
        } finally {
            this.store.releaseDownload(sessionKey);
            for (const filePath of createdPaths) {
                await this.fileSystem.rm(filePath, { force: true }).catch(() => {});
            }
        }
    }

    /**
     * 按 QQ 语音时长上限切段。segmentSeconds<=0 或整段不超限时返回原文件。
     * 依赖 ffmpeg；失败时回退整段发送，避免点歌完全不可用。
     */
    async splitAudioForVoice(audioPath, { format = 'mp3', segmentSeconds = 0, durationSeconds = 0 } = {}) {
        const seconds = Number(segmentSeconds) || 0;
        if (seconds <= 0) {
            return [audioPath];
        }
        const duration = Number(durationSeconds) || 0;
        if (duration > 0 && duration <= seconds) {
            return [audioPath];
        }
        if (!this.audioDir) {
            throw new Error('未配置音频临时目录');
        }

        const collectSegments = async (pattern, ext) => {
            const names = await this.fileSystem.readdir(this.audioDir);
            const prefix = path.basename(pattern).split('%03d')[0];
            return names
                .filter((name) => name.startsWith(prefix) && name.endsWith(`.${ext}`))
                .sort()
                .map((name) => path.join(this.audioDir, name));
        };

        const inputExt = path.extname(audioPath).replace(/^\./, '').toLowerCase() || String(format || 'mp3').toLowerCase();
        const copyExt = inputExt || 'mp3';
        const copyPattern = path.join(
            this.audioDir,
            `music_seg_${Date.now()}_${randomBytes(3).toString('hex')}_%03d.${copyExt}`
        );

        try {
            // 1) 优先流复制（同容器最快）
            try {
                await this.runCommand(this.ffmpegPath, [
                    '-y',
                    '-i', audioPath,
                    '-f', 'segment',
                    '-segment_time', String(seconds),
                    '-reset_timestamps', '1',
                    '-c', 'copy',
                    copyPattern
                ]);
                const copied = await collectSegments(copyPattern, copyExt);
                if (copied.length > 0) {
                    return copied;
                }
            } catch (copyError) {
                this.logger?.warn?.(`[点歌] 流复制切段失败，改用 mp3 转码切段: ${copyError.message}`);
            }

            // 2) 回退：统一转 mp3 再切段，兼容 opus/m4a 输入给 QQ 语音
            const mp3Pattern = path.join(
                this.audioDir,
                `music_seg_${Date.now()}_${randomBytes(3).toString('hex')}_%03d.mp3`
            );
            await this.runCommand(this.ffmpegPath, [
                '-y',
                '-i', audioPath,
                '-f', 'segment',
                '-segment_time', String(seconds),
                '-reset_timestamps', '1',
                '-ar', '44100',
                '-ac', '2',
                '-c:a', 'libmp3lame',
                '-b:a', '192k',
                mp3Pattern
            ]);
            const encoded = await collectSegments(mp3Pattern, 'mp3');
            if (encoded.length > 0) {
                return encoded;
            }
            throw new Error('切段后未生成音频文件');
        } catch (error) {
            this.logger?.warn?.(`[点歌] 语音切段失败，回退整段发送: ${error.message}`);
            return [audioPath];
        }
    }

    async writeAudioFile(track) {
        if (!this.audioDir) {
            throw new Error('未配置音频临时目录');
        }
        await this.fileSystem.mkdir(this.audioDir, { recursive: true });
        // 文件名只用时间戳与随机串，避免歌名带来的路径穿越风险
        const filename = `music_${Date.now()}_${randomBytes(4).toString('hex')}.${track.format}`;
        const filePath = path.join(this.audioDir, filename);
        await this.fileSystem.writeFile(filePath, track.buffer);
        return filePath;
    }
}
