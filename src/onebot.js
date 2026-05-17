/**
 * OneBot WebSocket 客户端
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import fs from 'fs';

function summarizeMessagePayload(message) {
    if (typeof message === 'string') {
        const normalizedText = message.trim();
        return {
            kind: 'text',
            length: normalizedText.length,
            preview: normalizedText.slice(0, 120)
        };
    }

    if (!Array.isArray(message)) {
        return {
            kind: typeof message,
            preview: null
        };
    }

    const segmentTypes = message.map((segment) => segment?.type || 'unknown');
    const textPreview = message
        .filter((segment) => segment?.type === 'text')
        .map((segment) => String(segment?.data?.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 120);
    const hasRecord = message.some((segment) => segment?.type === 'record');

    return {
        kind: 'segment_array',
        segmentCount: message.length,
        segmentTypes,
        preview: textPreview || null,
        containsRecord: hasRecord
    };
}

function summarizeOneBotParams(action, params = {}) {
    if (action === 'send_group_msg') {
        return {
            groupId: params.group_id ? String(params.group_id) : '',
            message: summarizeMessagePayload(params.message)
        };
    }

    if (action === 'send_private_msg') {
        return {
            userId: params.user_id ? String(params.user_id) : '',
            message: summarizeMessagePayload(params.message)
        };
    }

    if (action === 'get_login_info' || action === 'get_group_list' || action === 'get_friend_list') {
        return {};
    }

    return Object.keys(params || {}).length > 0
        ? { keys: Object.keys(params) }
        : {};
}

function summarizeOneBotResult(action, result) {
    if (action === 'get_login_info') {
        return {
            userId: result?.user_id ? String(result.user_id) : '',
            nickname: result?.nickname || ''
        };
    }

    if (action === 'get_group_list' || action === 'get_friend_list') {
        return {
            count: Array.isArray(result) ? result.length : 0
        };
    }

    if (result && typeof result === 'object' && !Array.isArray(result)) {
        return {
            keys: Object.keys(result).slice(0, 10)
        };
    }

    if (Array.isArray(result)) {
        return {
            count: result.length
        };
    }

    return {
        type: typeof result
    };
}

export function buildMentionMessage(targetUserId, text) {
    const normalizedTargetUserId = String(targetUserId || '').trim();
    const normalizedText = String(text || '').trim();

    return [
        { type: 'at', data: { qq: normalizedTargetUserId } },
        { type: 'text', data: { text: normalizedText ? ` ${normalizedText}` : '' } }
    ];
}

export class OneBotClient extends EventEmitter {
    constructor(config, logger) {
        super();
        this.config = config;
        this.logger = logger;
        this.ws = null;
        this.selfId = null;
        this.connected = false;
        this.pendingCalls = new Map();
        this.callId = 0;
        this.lastError = null;
        this.lastClose = null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 60000; // 最大 60 秒
        this.pingInterval = null;
        this.pongTimeout = null;
    }

    connect() {
        if (this.ws) { this.ws.close(); }

        const mode = this.config.mode || 'ws';
        if (mode === 'http') {
            this.connected = true;
            this.emit('connected');
            this.logger.info(`OneBot HTTP 模式已就绪 (上报地址: POST /onebot/event)`);
            // HTTP 模式下获取登录信息
            this._call('get_login_info').then(info => {
                this.selfId = info.user_id;
                this.logger.info(`登录账号: ${info.nickname} (${info.user_id})`);
            }).catch(err => {
                this.logger.error(`获取登录信息失败: ${err.message}`);
            });
            return;
        }

        // WS 模式
        const url = this.buildConnectionUrl();
        const headers = this.buildConnectionHeaders();
        this.logger.info(`正在连接 OneBot (WS): ${url}`);

        this.ws = new WebSocket(url, headers ? { headers } : undefined);

        this.ws.on('open', () => {
            this.connected = true;
            this.reconnectAttempts = 0; // 重置重连计数
            this.emit('connected');
            this._startPing();
            this._call('get_login_info').then(info => {
                this.selfId = info.user_id;
                this.logger.info(`登录账号: ${info.nickname} (${info.user_id})`);
            }).catch(err => {
                this.logger.error(`获取登录信息失败: ${err.message}`);
            });
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this._handleMessage(msg);
            } catch (e) {
                this.logger.error(`解析消息失败: ${e.message}`);
            }
        });

        this.ws.on('pong', () => {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        });

        this.ws.on('close', (code, reason) => {
            this.connected = false;
            this._stopPing();
            this.emit('disconnected');
            const reasonStr = reason?.toString() || '';
            this.lastClose = { code, reason: reasonStr, at: Date.now() };
            this.logger.warn(`OneBot 连接关闭 code=${code} reason=${reasonStr||'无'}`);

            // 指数退避重连
            this.reconnectAttempts += 1;
            const baseDelay = this.config.reconnectInterval || 5000;
            const delay = Math.min(
                baseDelay * Math.pow(2, this.reconnectAttempts - 1),
                this.maxReconnectDelay
            );
            this.logger.info(`将在 ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次尝试)`);
            setTimeout(() => this.connect(), delay);
        });

        this.ws.on('error', (err) => {
            const msg = err.message || String(err);
            this.lastError = { message: msg, at: Date.now() };
            this.logger.error(`WebSocket 错误: ${msg}`);
        });
    }

    // HTTP 模式：接收 OneBot 推送的事件
    handleHttpEvent(eventData) {
        if (eventData.post_type === 'message' || eventData.post_type === 'notice' || eventData.post_type === 'request') {
            this.emit('message', eventData);
        }
        if (eventData.echo !== undefined) {
            this._handleMessage(eventData);
        }
    }

    getNormalizedToken() {
        const token = typeof this.config.accessToken === 'string'
            ? this.config.accessToken.trim()
            : '';
        return token || '';
    }

    buildConnectionHeaders() {
        const token = this.getNormalizedToken();
        if (!token) {
            return null;
        }

        if (this.config.tokenMode === 'query') {
            return null;
        }

        // NapCat/LLOneBot 兼容：header 模式和 query 模式
        if (this.config.tokenMode === 'header') {
            return { Authorization: `Bearer ${token}` };
        }
        // 默认：直接传 token 不带前缀（兼容更多实现）
        return { Authorization: token };
    }

    buildConnectionUrl() {
        const baseUrl = this.config.url;
        const token = this.getNormalizedToken();
        if (!token || this.config.tokenMode !== 'query') {
            return baseUrl;
        }

        try {
            const parsed = new URL(baseUrl);
            if (!parsed.searchParams.has('access_token')) {
                parsed.searchParams.set('access_token', token);
            }
            return parsed.toString();
        } catch {
            return baseUrl;
        }
    }

    _handleMessage(msg) {
        // 处理 API 响应
        if (msg.echo !== undefined) {
            const pending = this.pendingCalls.get(msg.echo);
            if (pending) {
                this.pendingCalls.delete(msg.echo);
                if (msg.status === 'ok' || msg.retcode === 0) {
                    pending.resolve(msg.data);
                } else {
                    pending.reject(new Error(msg.message || msg.wording || 'API 调用失败'));
                }
            }
            return;
        }

        // 处理事件
        if (msg.post_type === 'message') {
            this.emit('message', msg);
        } else if (msg.post_type === 'meta_event') {
            if (msg.meta_event_type === 'heartbeat') {
                // 心跳，忽略
            } else if (msg.meta_event_type === 'lifecycle') {
                this.logger.debug(`生命周期事件: ${msg.sub_type}`);
            }
        }
    }

    _call(action, params = {}) {
        // HTTP 模式：直接 fetch
        if ((this.config.mode || 'ws') === 'http') {
            const httpUrl = (this.config.url || '').replace(/\/+$/, '');
            const apiUrl = `${httpUrl}/${action}`;
            return fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.buildConnectionHeaders() },
                body: JSON.stringify(params)
            }).then(r => r.json()).then(data => {
                if (data.status === 'ok' || data.retcode === 0) return data.data;
                throw new Error(data.msg || data.wording || 'API调用失败');
            });
        }

        // WS 模式
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                this.logger.error?.('[OneBot] API 调用失败: 未连接', { action });
                reject(new Error('未连接到 OneBot'));
                return;
            }

            const echo = ++this.callId;
            const startedAt = Date.now();
            const summarizedParams = summarizeOneBotParams(action, params);
            this.logger.debug?.('[OneBot] API 调用开始', {
                action,
                echo,
                params: summarizedParams
            });

            this.pendingCalls.set(echo, {
                resolve: (data) => {
                    this.logger.info?.('[OneBot] API 调用成功', {
                        action,
                        echo,
                        durationMs: Date.now() - startedAt,
                        result: summarizeOneBotResult(action, data)
                    });
                    resolve(data);
                },
                reject: (error) => {
                    this.logger.error?.('[OneBot] API 调用失败', {
                        action,
                        echo,
                        durationMs: Date.now() - startedAt,
                        error: error.message,
                        params: summarizedParams
                    });
                    reject(error);
                }
            });

            this.ws.send(JSON.stringify({
                action,
                params,
                echo
            }));

            // 超时处理
            setTimeout(() => {
                if (this.pendingCalls.has(echo)) {
                    this.pendingCalls.delete(echo);
                    const timeoutError = new Error('API 调用超时');
                    this.logger.error?.('[OneBot] API 调用超时', {
                        action,
                        echo,
                        durationMs: Date.now() - startedAt,
                        params: summarizedParams
                    });
                    reject(timeoutError);
                }
            }, 30000);
        });
    }

    async sendGroupMessage(groupId, message) {
        return this._call('send_group_msg', {
            group_id: groupId,
            message: typeof message === 'string' ? message : message
        });
    }

    async sendPrivateMessage(userId, message) {
        return this._call('send_private_msg', {
            user_id: userId,
            message: typeof message === 'string' ? message : message
        });
    }

    buildReplyMessage(messageId, content) {
        if (!messageId) {
            return content;
        }

        if (Array.isArray(content)) {
            return [
                { type: 'reply', data: { id: String(messageId) } },
                ...content
            ];
        }

        return [
            { type: 'reply', data: { id: String(messageId) } },
            { type: 'text', data: { text: String(content) } }
        ];
    }

    async sendGroupReply(groupId, messageId, message) {
        return this.sendGroupMessage(groupId, this.buildReplyMessage(messageId, message));
    }

    async sendPrivateReply(userId, messageId, message) {
        return this.sendPrivateMessage(userId, this.buildReplyMessage(messageId, message));
    }

    async getGroupList() {
        return this._call('get_group_list');
    }

    async getFriendList() {
        return this._call('get_friend_list');
    }

    async getMessage(messageId) {
        return this._call('get_msg', {
            message_id: Number(messageId)
        });
    }

    /**
     * 发送群语音消息（使用 base64 编码，兼容 Docker 环境）
     * @param {number} groupId - 群号
     * @param {string} filePath - 音频文件路径（绝对路径）
     */
    async sendGroupRecord(groupId, filePath) {
        // 读取文件并转换为 base64
        const audioData = fs.readFileSync(filePath);
        const base64Data = audioData.toString('base64');
        
        return this._call('send_group_msg', {
            group_id: groupId,
            message: [
                {
                    type: 'record',
                    data: {
                        file: `base64://${base64Data}`
                    }
                }
            ]
        });
    }

    /**
     * 发送私聊语音消息（使用 base64 编码，兼容 Docker 环境）
     * @param {number} userId - 用户 QQ 号
     * @param {string} filePath - 音频文件路径（绝对路径）
     */
    async sendPrivateRecord(userId, filePath) {
        // 读取文件并转换为 base64
        const audioData = fs.readFileSync(filePath);
        const base64Data = audioData.toString('base64');
        
        return this._call('send_private_msg', {
            user_id: userId,
            message: [
                {
                    type: 'record',
                    data: {
                        file: `base64://${base64Data}`
                    }
                }
            ]
        });
    }

    /**
     * 检查是否已连接
     */
    isConnected() {
        return this.connected;
    }

    getStatus() {
        return {
            connected: this.connected,
            url: this.config?.url || '',
            mode: this.config?.mode || 'ws',
            tokenMode: this.config?.tokenMode || 'header',
            hasToken: !!this.getNormalizedToken(),
            selfId: this.selfId || null,
            readyState: this.ws?.readyState ?? null,
            lastError: this.lastError,
            lastClose: this.lastClose
        };
    }

    /**
     * 给消息添加表情回应，表示已收到
     * @param {string} messageId 原始消息 ID
     * @param {string|number} emojiId QQ 表情 ID，默认 289
     */
    async setMsgEmojiLike(messageId, emojiId = '289') {
        try {
            await this._call('set_msg_emoji_like', {
                message_id: parseInt(messageId, 10),
                emoji_id: String(emojiId),
                emoji_type: '1'
            });
        } catch (e) {
            this.logger?.debug?.(`表情回应失败 (API 可能不支持): ${e.message}`);
        }
    }

    /**
     * 戳一戳群成员
     * @param {string|number} groupId 群号
     * @param {string|number} userId 目标用户 QQ 号
     */
    async sendGroupPoke(groupId, userId) {
        return this._call('group_poke', {
            group_id: parseInt(groupId, 10),
            user_id: parseInt(userId, 10)
        });
    }

    /**
     * 私聊戳一戳
     * @param {string|number} userId 目标用户 QQ 号
     */
    async sendFriendPoke(userId) {
        return this._call('friend_poke', {
            user_id: parseInt(userId, 10)
        });
    }

    /**
     * 手动重新连接
     */
    reconnect() {
        this.logger.info('手动触发重新连接...');
        this._stopPing();
        if (this.ws) {
            this.ws.close();
        }
        this.reconnectAttempts = 0;
        this.connect();
    }

    _startPing() {
        this._stopPing();
        const interval = this.config.pingInterval || 30000;
        this.pingInterval = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            this.ws.ping();
            this.pongTimeout = setTimeout(() => {
                this.logger.warn('OneBot 心跳超时，主动断开重连');
                if (this.ws) this.ws.terminate();
            }, 10000);
        }, interval);
    }

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }
}
