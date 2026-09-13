/**
 * MCP 客户端管理器
 * 使用官方 @modelcontextprotocol/sdk 的 Client，连接外部 MCP 服务器（stdio / streamable-http / sse），
 * 把服务器工具以 mcp__<server>__<tool> 命名空间并入 bot 工具表。
 */

import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { clampInteger } from './search/http.js';

const SUPPORTED_TRANSPORTS = ['stdio', 'http', 'sse'];
const RETRY_DELAYS_MS = [1000, 5000, 15000];
const MAX_FUNCTION_NAME_LENGTH = 64;

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringMap(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return result;
    }
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey || typeof item !== 'string') {
            continue;
        }
        result[normalizedKey] = item;
    }
    return result;
}

function normalizeToolNameList(value) {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,，\s]+/) : []);
    const seen = new Set();
    const list = [];
    for (const item of source) {
        const text = normalizeString(item);
        if (!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        list.push(text);
    }
    return list;
}

/** 归一化单个 MCP 服务器配置 */
export function normalizeMcpServerConfig(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const name = normalizeString(raw.name);
    if (!name) {
        return null;
    }
    const transport = SUPPORTED_TRANSPORTS.includes(normalizeString(raw.transport).toLowerCase())
        ? normalizeString(raw.transport).toLowerCase()
        : 'stdio';
    const toolFilter = raw.toolFilter && typeof raw.toolFilter === 'object' ? raw.toolFilter : {};

    return {
        id: normalizeString(raw.id) || randomUUID(),
        name,
        enabled: raw.enabled !== false,
        transport,
        command: normalizeString(raw.command),
        args: Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : [],
        env: normalizeStringMap(raw.env),
        cwd: normalizeString(raw.cwd),
        url: normalizeString(raw.url),
        headers: normalizeStringMap(raw.headers),
        timeoutMs: clampInteger(raw.timeoutMs, 1000, 600000, 60000),
        toolFilter: {
            include: normalizeToolNameList(toolFilter.include),
            exclude: normalizeToolNameList(toolFilter.exclude)
        }
    };
}

/** 归一化 config.mcp.client 配置 */
export function normalizeMcpClientConfig(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const servers = Array.isArray(source.servers)
        ? source.servers.map((item) => normalizeMcpServerConfig(item)).filter(Boolean)
        : [];
    return {
        enabled: source.enabled === true,
        maxResultChars: clampInteger(source.maxResultChars, 500, 50000, 4000),
        servers
    };
}

function maskSecretMap(map = {}) {
    const masked = {};
    for (const [key, value] of Object.entries(map || {})) {
        masked[key] = value ? '******' : '';
    }
    return masked;
}

/** 输出给前端的服务器配置（密钥字段掩码，附带 hasEnv/hasHeaders） */
export function maskMcpServerForClient(server = {}) {
    const env = normalizeStringMap(server.env);
    const headers = normalizeStringMap(server.headers);
    return {
        ...server,
        env: maskSecretMap(env),
        headers: maskSecretMap(headers),
        hasEnv: Object.values(env).some(Boolean),
        hasHeaders: Object.values(headers).some(Boolean)
    };
}

/**
 * 合并密钥字段：值为 '******' 时沿用旧值；缺失的键视为删除。
 */
export function mergeMcpSecrets(next = {}, existing = {}) {
    const merged = {};
    for (const [key, value] of Object.entries(next || {})) {
        if (value === '******') {
            if (Object.prototype.hasOwnProperty.call(existing || {}, key)) {
                merged[key] = existing[key];
            }
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

function sanitizeIdentifier(value) {
    const text = String(value || '').trim();
    const sanitized = text.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    return sanitized || 'tool';
}

function shortHash(value) {
    return createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
}

function buildFunctionName(serverName, toolName) {
    const serverSlug = sanitizeIdentifier(serverName);
    let toolSlug = sanitizeIdentifier(toolName);
    const prefix = `mcp__${serverSlug}__`;
    const available = MAX_FUNCTION_NAME_LENGTH - prefix.length;
    if (available <= 0) {
        const compact = `${serverSlug}_${toolSlug}`.slice(0, 24);
        return `mcp__${compact}__${shortHash(`${serverName}:${toolName}`)}`;
    }
    if (toolSlug.length > available) {
        const hash = shortHash(`${serverName}:${toolName}`);
        toolSlug = `${toolSlug.slice(0, Math.max(1, available - hash.length - 1))}_${hash}`;
    }
    return `${prefix}${toolSlug}`;
}

function normalizeInputSchema(schema) {
    let source = {};
    if (schema && typeof schema === 'object') {
        try {
            source = JSON.parse(JSON.stringify(schema));
        } catch {
            source = {};
        }
    }
    delete source.$schema;
    if (!source.type || source.type !== 'object') {
        source = { type: 'object', properties: { input: source }, required: ['input'] };
    }
    if (!source.properties || typeof source.properties !== 'object') {
        source.properties = {};
    }
    if (!Array.isArray(source.required)) {
        delete source.required;
    }
    return source;
}

function normalizeCallResult(result, maxResultChars) {
    const parts = [];
    const content = Array.isArray(result?.content) ? result.content : [];
    for (const item of content) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        if (item.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
        } else if (item.type === 'image') {
            parts.push(`[image ${item.mimeType || 'unknown'}${item.data ? `, base64 ~${Math.round(String(item.data).length * 0.75)} bytes` : ''}]`);
        } else if (item.type === 'audio') {
            parts.push(`[audio ${item.mimeType || 'unknown'}]`);
        } else if (item.type === 'resource') {
            const resource = item.resource || {};
            if (typeof resource.text === 'string') {
                parts.push(`[resource ${resource.uri || ''}]\n${resource.text}`);
            } else {
                parts.push(`[resource ${resource.uri || ''} (${resource.mimeType || 'binary'})]`);
            }
        } else if (item.type === 'resource_link') {
            parts.push(`[resource link ${item.uri || ''}]`);
        }
    }

    let text = parts.join('\n').trim();
    if (!text && result?.structuredContent) {
        try {
            text = JSON.stringify(result.structuredContent);
        } catch {
            text = '';
        }
    }
    const truncated = text.length > maxResultChars;
    if (truncated) {
        text = `${text.slice(0, maxResultChars)}\n…（结果已截断）`;
    }
    return { text, truncated };
}

function entrySignature(server) {
    return JSON.stringify({
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        url: server.url,
        headers: server.headers,
        timeoutMs: server.timeoutMs,
        toolFilter: server.toolFilter
    });
}

export class McpClientManager {
    constructor({ config = {}, logger = console } = {}) {
        this.config = config;
        this.logger = logger;
        this.servers = new Map();
        this.closed = false;

        this.exitHandler = () => {
            for (const entry of this.servers.values()) {
                try {
                    entry.transport?.close?.();
                } catch {
                    // 退出阶段忽略清理错误
                }
            }
        };
        process.once('exit', this.exitHandler);
    }

    getClientConfig() {
        const raw = this.config.mcp?.client;
        return normalizeMcpClientConfig(raw);
    }

    /** 启动时连接所有已启用服务器（不阻塞主流程） */
    start() {
        const config = this.getClientConfig();
        for (const server of config.servers) {
            this.ensureEntry(server);
        }
        for (const server of config.servers) {
            if (!config.enabled || !server.enabled) {
                const entry = this.servers.get(server.id);
                if (entry) {
                    entry.state = 'disabled';
                }
                continue;
            }
            this.connectServer(server.id).catch((error) => {
                this.logger?.warn?.('[MCP] 初始连接失败', { server: server.name, error: error.message });
            });
        }
    }

    ensureEntry(serverConfig) {
        let entry = this.servers.get(serverConfig.id);
        if (!entry) {
            entry = {
                id: serverConfig.id,
                config: serverConfig,
                name: serverConfig.name,
                enabled: serverConfig.enabled,
                transport: serverConfig.transport,
                state: 'disabled',
                tools: new Map(),
                lastError: '',
                connectedAt: '',
                retryCount: 0,
                retryTimer: null,
                client: null,
                transportClient: null,
                closing: false
            };
            this.servers.set(serverConfig.id, entry);
        }
        return entry;
    }

    /** 配置热重载：diff 后重连变化的服务器 */
    async reload() {
        const config = this.getClientConfig();
        const wanted = new Map(config.servers.map((server) => [server.id, server]));

        for (const [id, entry] of [...this.servers.entries()]) {
            if (!wanted.has(id)) {
                await this.closeServer(id);
                this.servers.delete(id);
                continue;
            }
            const nextConfig = wanted.get(id);
            const changed = entrySignature(entry.config) !== entrySignature(nextConfig);
            entry.config = nextConfig;
            entry.name = nextConfig.name;
            entry.enabled = nextConfig.enabled;
            entry.transport = nextConfig.transport;
            if (changed && entry.state !== 'disabled') {
                entry.state = 'disabled';
            }
        }

        const tasks = [];
        for (const server of config.servers) {
            const entry = this.ensureEntry(server);
            entry.config = server;
            entry.name = server.name;
            entry.enabled = server.enabled;
            entry.transport = server.transport;

            if (!config.enabled || !server.enabled) {
                if (entry.client || entry.transportClient) {
                    await this.closeServer(server.id);
                }
                entry.state = 'disabled';
                entry.lastError = '';
                continue;
            }

            if (entry.state === 'connected' || entry.state === 'connecting') {
                continue;
            }
            entry.retryCount = 0;
            tasks.push(this.connectServer(server.id));
        }

        await Promise.allSettled(tasks);
        return this.getStatus();
    }

    createTransport(server) {
        if (server.transport === 'http') {
            return new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: { ...server.headers } }
            });
        }
        if (server.transport === 'sse') {
            return new SSEClientTransport(new URL(server.url), {
                requestInit: { headers: { ...server.headers } }
            });
        }

        let command = server.command;
        let args = [...server.args];
        if (process.platform === 'win32' && command && !command.includes('\\') && !command.includes('/') && !/\.(exe|cmd|bat|com)$/i.test(command)) {
            // Windows 下 npx/uv 等多为 .cmd/.exe 包装，统一交给 cmd.exe 解析
            args = ['/c', command, ...args];
            command = process.env.ComSpec || 'cmd.exe';
        }

        return new StdioClientTransport({
            command,
            args,
            cwd: server.cwd || undefined,
            env: { ...getDefaultEnvironment(), ...server.env },
            stderr: 'pipe'
        });
    }

    async connectServer(id) {
        const entry = this.servers.get(id);
        if (!entry || this.closed) {
            return;
        }
        await this.closeServer(id);
        if (!entry.config.enabled) {
            entry.state = 'disabled';
            return;
        }

        entry.state = 'connecting';
        entry.lastError = '';
        const timeoutMs = Math.min(entry.config.timeoutMs || 60000, 20000);

        try {
            const client = new Client({ name: 'mimir-link', version: '1.1.0' }, { capabilities: {} });
            const transport = this.createTransport(entry.config);
            entry.client = client;
            entry.transportClient = transport;

            if (transport.stderr && typeof transport.stderr.on === 'function') {
                transport.stderr.on('data', (chunk) => {
                    const text = String(chunk || '').trim();
                    if (text) {
                        this.logger?.debug?.('[MCP] stderr', { server: entry.name, text: text.slice(0, 500) });
                    }
                });
            }

            transport.onclose = () => {
                if (entry.closing || entry.state !== 'connected') {
                    return;
                }
                this.logger?.warn?.('[MCP] 连接已断开', { server: entry.name });
                entry.state = 'error';
                entry.lastError = '连接已断开';
                entry.client = null;
                entry.transportClient = null;
                this.scheduleRetry(entry.id);
            };
            transport.onerror = (error) => {
                entry.lastError = error?.message || String(error);
            };

            await client.connect(transport, { timeout: timeoutMs });
            const listed = await client.listTools({}, { timeout: timeoutMs });
            entry.tools = new Map((Array.isArray(listed?.tools) ? listed.tools : []).map((tool) => [tool.name, tool]));
            entry.state = 'connected';
            entry.connectedAt = new Date().toISOString();
            entry.retryCount = 0;
            entry.lastError = '';
            this.logger?.info?.('[MCP] 服务器已连接', {
                server: entry.name,
                transport: entry.transport,
                toolCount: entry.tools.size
            });
        } catch (error) {
            entry.state = 'error';
            entry.lastError = error?.message || String(error);
            entry.tools = new Map();
            this.logger?.warn?.('[MCP] 连接失败', { server: entry.name, error: entry.lastError });
            this.scheduleRetry(entry.id);
        }
    }

    scheduleRetry(id) {
        const entry = this.servers.get(id);
        if (!entry || this.closed) {
            return;
        }
        if (entry.retryTimer) {
            clearTimeout(entry.retryTimer);
            entry.retryTimer = null;
        }
        if (entry.retryCount >= RETRY_DELAYS_MS.length) {
            this.logger?.warn?.('[MCP] 重试次数已用尽，等待手动重连', { server: entry.name });
            return;
        }
        const delay = RETRY_DELAYS_MS[entry.retryCount];
        entry.retryCount += 1;
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            this.connectServer(id).catch(() => {});
        }, delay);
        if (typeof entry.retryTimer.unref === 'function') {
            entry.retryTimer.unref();
        }
    }

    async reconnect(id) {
        const entry = this.servers.get(id);
        if (!entry) {
            return { ok: false, error: '服务器不存在' };
        }
        entry.retryCount = 0;
        await this.connectServer(id);
        return { ok: entry.state === 'connected', state: entry.state, error: entry.lastError };
    }

    async closeServer(id) {
        const entry = this.servers.get(id);
        if (!entry) {
            return;
        }
        entry.closing = true;
        if (entry.retryTimer) {
            clearTimeout(entry.retryTimer);
            entry.retryTimer = null;
        }
        try {
            await entry.client?.close?.();
        } catch {
            // 忽略关闭阶段错误
        }
        entry.client = null;
        entry.transportClient = null;
        entry.tools = new Map();
        entry.closing = false;
    }

    /** 工具列表（已按服务器与过滤规则裁剪，供模型工具表使用） */
    getToolDefinitions() {
        const clientConfig = this.getClientConfig();
        if (!clientConfig.enabled) {
            return [];
        }
        const definitions = [];
        const usedNames = new Set();
        for (const entry of this.servers.values()) {
            if (entry.state !== 'connected' || !entry.config.enabled) {
                continue;
            }
            const include = entry.config.toolFilter?.include || [];
            const exclude = entry.config.toolFilter?.exclude || [];
            for (const tool of entry.tools.values()) {
                if (include.length > 0 && !include.includes(tool.name)) {
                    continue;
                }
                if (exclude.includes(tool.name)) {
                    continue;
                }
                let functionName = buildFunctionName(entry.name, tool.name);
                if (usedNames.has(functionName)) {
                    functionName = `${functionName.slice(0, 50)}_${shortHash(`${entry.id}:${tool.name}`)}`;
                }
                usedNames.add(functionName);
                definitions.push({
                    name: functionName,
                    serverId: entry.id,
                    serverName: entry.name,
                    toolName: tool.name,
                    definition: {
                        type: 'function',
                        function: {
                            name: functionName,
                            description: `[MCP:${entry.name}] ${tool.description || tool.name}`.slice(0, 1024),
                            parameters: normalizeInputSchema(tool.inputSchema)
                        }
                    }
                });
            }
        }
        return definitions;
    }

    async callTool({ serverId, tool, arguments: args = {}, timeoutMs = null } = {}) {
        const entry = this.servers.get(serverId);
        if (!entry) {
            return { ok: false, error: 'MCP 服务器不存在' };
        }
        if (entry.state !== 'connected' || !entry.client) {
            return { ok: false, error: `MCP 服务器未连接（${entry.lastError || entry.state}）` };
        }
        if (!entry.tools.has(tool)) {
            return { ok: false, error: `MCP 服务器上没有工具: ${tool}` };
        }

        const clientConfig = this.getClientConfig();
        const effectiveTimeout = clampInteger(timeoutMs || entry.config.timeoutMs, 1000, 600000, 60000);
        const startedAt = Date.now();
        try {
            const result = await entry.client.callTool({ name: tool, arguments: args || {} }, undefined, { timeout: effectiveTimeout });
            const normalized = normalizeCallResult(result, clientConfig.maxResultChars);
            this.logger?.info?.('[MCP] 工具调用完成', {
                server: entry.name,
                tool,
                isError: result?.isError === true,
                durationMs: Date.now() - startedAt,
                chars: normalized.text.length
            });
            if (result?.isError === true) {
                return { ok: false, error: normalized.text || 'MCP 工具返回错误', truncated: normalized.truncated };
            }
            return {
                ok: true,
                server: entry.name,
                tool,
                text: normalized.text,
                truncated: normalized.truncated
            };
        } catch (error) {
            this.logger?.warn?.('[MCP] 工具调用失败', { server: entry.name, tool, error: error?.message });
            return { ok: false, error: error?.message || String(error) };
        }
    }

    getStatus() {
        const clientConfig = this.getClientConfig();
        return {
            enabled: clientConfig.enabled,
            maxResultChars: clientConfig.maxResultChars,
            servers: [...this.servers.values()].map((entry) => ({
                id: entry.id,
                name: entry.name,
                transport: entry.transport,
                enabled: entry.config.enabled !== false,
                state: entry.state,
                connectedAt: entry.connectedAt || '',
                lastError: entry.lastError || '',
                retryCount: entry.retryCount || 0,
                toolCount: entry.tools.size,
                tools: [...entry.tools.values()].map((tool) => ({
                    name: tool.name,
                    description: tool.description || '',
                    required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : []
                })),
                config: maskMcpServerForClient(entry.config)
            }))
        };
    }

    async close() {
        this.closed = true;
        process.removeListener('exit', this.exitHandler);
        for (const id of [...this.servers.keys()]) {
            await this.closeServer(id);
        }
    }
}
