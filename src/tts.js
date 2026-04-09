/**
 * TTS 语音合成模块 - 豆包语音 API V3 (语音合成2.0)
 * 文档: https://www.volcengine.com/docs/6561/1329505
 * 
 * 使用 WebSocket 双向流式接口: wss://openspeech.bytedance.com/api/v3/tts/bidirection
 * 支持大模型音色（如 zh_female_shuangkuaisisi_moon_bigtts 等）
 */

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 音频缓存目录
const AUDIO_DIR = path.join(__dirname, '../audio');

// WebSocket 端点
const WS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.chat';
const TTS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const TTS_MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const TTS_MAX_CACHE_FILES = 50;

// 事件类型定义
const Events = {
    // 上行事件
    StartConnection: 1,
    FinishConnection: 2,
    StartSession: 100,
    CancelSession: 101,
    FinishSession: 102,
    TaskRequest: 200,
    
    // 下行事件
    ConnectionStarted: 50,
    ConnectionFailed: 51,
    ConnectionFinished: 52,
    SessionStarted: 150,
    SessionCanceled: 151,
    SessionFinished: 152,
    SessionFailed: 153,
    TTSSentenceStart: 350,
    TTSSentenceEnd: 351,
    TTSResponse: 352
};

/**
 * 构建二进制协议帧
 */
function buildFrame(messageType, messageTypeFlags, serializationMethod, compressionMethod, eventNumber, sessionId, payload) {
    // Header: 4 bytes
    // Byte 0: Protocol version (4 bits) + Header size (4 bits)
    // Byte 1: Message type (4 bits) + Message type specific flags (4 bits)
    // Byte 2: Serialization method (4 bits) + Compression method (4 bits)
    // Byte 3: Reserved
    
    const header = Buffer.alloc(4);
    header[0] = 0x11; // v1, 4-byte header
    header[1] = (messageType << 4) | messageTypeFlags;
    header[2] = (serializationMethod << 4) | compressionMethod;
    header[3] = 0x00;
    
    const parts = [header];
    
    // 如果有事件号 (messageTypeFlags & 0x04)
    if (messageTypeFlags & 0x04) {
        const eventBuf = Buffer.alloc(4);
        eventBuf.writeInt32BE(eventNumber);
        parts.push(eventBuf);
    }
    
    // 如果有 session ID
    if (sessionId) {
        const sessionIdBuf = Buffer.from(sessionId, 'utf-8');
        const sessionIdLenBuf = Buffer.alloc(4);
        sessionIdLenBuf.writeUInt32BE(sessionIdBuf.length);
        parts.push(sessionIdLenBuf);
        parts.push(sessionIdBuf);
    }
    
    // Payload
    if (payload) {
        const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf-8');
        const payloadLenBuf = Buffer.alloc(4);
        payloadLenBuf.writeUInt32BE(payloadBuf.length);
        parts.push(payloadLenBuf);
        parts.push(payloadBuf);
    }
    
    return Buffer.concat(parts);
}

/**
 * 解析二进制协议帧
 * 参考文档: https://www.volcengine.com/docs/6561/1329505
 */
function parseFrame(data) {
    if (data.length < 4) {
        return { error: 'Frame too short' };
    }
    
    const header = {
        protocolVersion: (data[0] >> 4) & 0x0F,
        headerSize: (data[0] & 0x0F) * 4,
        messageType: (data[1] >> 4) & 0x0F,
        messageTypeFlags: data[1] & 0x0F,
        serializationMethod: (data[2] >> 4) & 0x0F,
        compressionMethod: data[2] & 0x0F
    };
    
    // 使用 headerSize 作为起始偏移
    let offset = header.headerSize;
    let eventNumber = null;
    let sessionId = null;
    let payload = null;
    
    // 检查是否有事件号 (messageTypeFlags bit 2)
    const hasEvent = (header.messageTypeFlags & 0x04) !== 0;
    
    if (hasEvent && offset + 4 <= data.length) {
        eventNumber = data.readInt32BE(offset);
        offset += 4;
    }
    
    // 检查是否是错误帧 (messageType = 0x0F)
    if (header.messageType === 0x0F) {
        // 错误帧格式: header + error_code (4 bytes) + payload
        if (offset + 4 <= data.length) {
            const errorCode = data.readInt32BE(offset);
            offset += 4;
            
            if (offset + 4 <= data.length) {
                const payloadLen = data.readUInt32BE(offset);
                offset += 4;
                if (offset + payloadLen <= data.length) {
                    const payloadBuf = data.slice(offset, offset + payloadLen);
                    try {
                        payload = JSON.parse(payloadBuf.toString('utf-8'));
                    } catch (e) {
                        payload = payloadBuf.toString('utf-8');
                    }
                }
            }
            
            return { header, eventNumber, errorCode, payload, isError: true };
        }
    }
    
    // 检查是否有 sequence number (messageTypeFlags bit 0)
    const hasSequence = (header.messageTypeFlags & 0x01) !== 0;
    let sequenceNumber = null;
    if (hasSequence && offset + 4 <= data.length) {
        sequenceNumber = data.readInt32BE(offset);
        offset += 4;
    }
    
    // 对于 session 相关事件 (100-199, 150-199, 200-399, 350-399)，读取 session ID
    // 实际上，所有带 session 的事件都应该有 session ID
    if (eventNumber !== null && eventNumber >= 100) {
        if (offset + 4 <= data.length) {
            const sessionIdLen = data.readUInt32BE(offset);
            offset += 4;
            if (sessionIdLen > 0 && sessionIdLen < 100 && offset + sessionIdLen <= data.length) {
                sessionId = data.slice(offset, offset + sessionIdLen).toString('utf-8');
                offset += sessionIdLen;
            }
        }
    }
    
    // 读取 payload
    if (offset + 4 <= data.length) {
        const payloadLen = data.readUInt32BE(offset);
        offset += 4;
        
        if (payloadLen > 0 && offset + payloadLen <= data.length) {
            const payloadBuf = data.slice(offset, offset + payloadLen);
            
            // 根据序列化方法解析
            if (header.serializationMethod === 0x01) {
                // JSON
                try {
                    payload = JSON.parse(payloadBuf.toString('utf-8'));
                } catch (e) {
                    payload = payloadBuf.toString('utf-8');
                }
            } else {
                // Raw binary (音频数据)
                payload = payloadBuf;
            }
        }
    }
    
    // 调试输出
    console.log(`[parseFrame] 总长度: ${data.length}, header: ${JSON.stringify(header)}, event: ${eventNumber}, sessionId: ${sessionId ? sessionId.substring(0, 8) + '...' : null}, payload类型: ${payload ? (Buffer.isBuffer(payload) ? `Buffer(${payload.length})` : typeof payload) : null}`);
    
    return { header, eventNumber, sessionId, sequenceNumber, payload };
}

/**
 * TTS 管理器
 */
export class TTSManager {
    constructor() {
        this.config = normalizeTTSConfig();

        if (!fs.existsSync(AUDIO_DIR)) {
            fs.mkdirSync(AUDIO_DIR, { recursive: true });
        }

        this.startCleanupTimer();
    }

    getConfig() {
        return { ...this.config };
    }

    updateConfig(options) {
        this.config = normalizeTTSConfig({ ...this.config, ...options });
        console.log(`[TTS ${this.config.provider}] 配置已更新:`, JSON.stringify(this.config, null, 2));
    }

    startCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }

        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanupAudio();
            } catch (error) {
                console.warn(`[TTS] 定时清理失败: ${error.message}`);
            }
        }, TTS_CLEANUP_INTERVAL_MS);
    }

    getResolvedBaseUrl() {
        if (this.config.baseUrl) {
            return this.config.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
        }

        if (this.config.provider === 'minimax') {
            return MINIMAX_DEFAULT_BASE_URL;
        }

        return '';
    }

    validateConfig() {
        if (!this.config.enabled) {
            throw new Error('TTS 未启用');
        }

        if (this.config.provider === 'minimax') {
            if (!this.config.apiKey) {
                throw new Error('TTS 配置不完整：缺少 API Key');
            }
            if (!this.config.modelId) {
                throw new Error('TTS 配置不完整：缺少模型 ID');
            }
            if (!this.config.voiceId) {
                throw new Error('TTS 配置不完整：缺少音色 ID');
            }
            return;
        }

        if (!this.config.appId) {
            throw new Error('TTS 配置不完整：缺少 App ID');
        }
        if (!this.config.apiKey) {
            throw new Error('TTS 配置不完整：缺少 API Key');
        }
        if (!this.config.voiceId) {
            throw new Error('TTS 配置不完整：缺少音色 ID');
        }
    }

    async synthesize(text) {
        this.validateConfig();

        if (text.length > 1000) {
            text = text.substring(0, 1000);
            console.log('[TTS] 文本过长，已截断至 1000 字符');
        }

        if (this.config.provider === 'minimax') {
            return this.synthesizeWithMinimax(text);
        }

        return this.synthesizeWithDoubao(text);
    }

    async synthesizeWithDoubao(text) {
        console.log(`[TTS Doubao] 音色: ${this.config.voiceId}, 文本: ${text.substring(0, 50)}...`);

        return new Promise((resolve, reject) => {
            const connectId = uuidv4();
            const sessionId = uuidv4();
            const audioChunks = [];
            const ws = new WebSocket(WS_ENDPOINT, {
                headers: {
                    'X-Api-App-Key': this.config.appId,
                    'X-Api-Access-Key': this.config.apiKey,
                    'X-Api-Resource-Id': 'seed-tts-2.0',
                    'X-Api-Connect-Id': connectId
                }
            });

            const timeout = setTimeout(() => {
                console.error('[TTS Doubao] 超时');
                ws.close();
                reject(new Error('TTS 请求超时'));
            }, 30000);

            ws.on('open', () => {
                const startConnFrame = buildFrame(0x01, 0x04, 0x01, 0x00, Events.StartConnection, null, {});
                ws.send(startConnFrame);
            });

            ws.on('message', (data) => {
                const frame = parseFrame(data);

                if (frame.isError) {
                    clearTimeout(timeout);
                    ws.close();
                    reject(new Error(`TTS 错误: ${frame.payload?.message || frame.errorCode}`));
                    return;
                }

                switch (frame.eventNumber) {
                    case Events.ConnectionStarted: {
                        const sessionPayload = {
                            user: { uid: 'mimirlink-user' },
                            event: Events.StartSession,
                            namespace: 'BidirectionalTTS',
                            req_params: {
                                text: '',
                                speaker: this.config.voiceId,
                                audio_params: {
                                    format: this.config.encoding,
                                    sample_rate: 24000
                                }
                            }
                        };

                        const startSessionFrame = buildFrame(0x01, 0x04, 0x01, 0x00, Events.StartSession, sessionId, sessionPayload);
                        ws.send(startSessionFrame);
                        break;
                    }
                    case Events.ConnectionFailed:
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(`TTS 连接失败: ${frame.payload?.message || 'Unknown error'}`));
                        break;
                    case Events.SessionStarted: {
                        const taskPayload = {
                            user: { uid: 'mimirlink-user' },
                            event: Events.TaskRequest,
                            namespace: 'BidirectionalTTS',
                            req_params: {
                                text,
                                speaker: this.config.voiceId,
                                audio_params: {
                                    format: this.config.encoding,
                                    sample_rate: 24000,
                                    speech_rate: Math.round((this.config.speed - 1) * 100),
                                    loudness_rate: Math.round((this.config.volume - 1) * 100)
                                }
                            }
                        };

                        ws.send(buildFrame(0x01, 0x04, 0x01, 0x00, Events.TaskRequest, sessionId, taskPayload));
                        ws.send(buildFrame(0x01, 0x04, 0x01, 0x00, Events.FinishSession, sessionId, {}));
                        break;
                    }
                    case Events.SessionFailed:
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(`TTS 会话失败: ${frame.payload?.message || 'Unknown error'}`));
                        break;
                    case Events.TTSResponse:
                        if (frame.payload && Buffer.isBuffer(frame.payload)) {
                            audioChunks.push(frame.payload);
                        } else if (frame.payload?.data) {
                            audioChunks.push(Buffer.from(frame.payload.data, 'base64'));
                        }
                        break;
                    case Events.SessionFinished:
                        ws.send(buildFrame(0x01, 0x04, 0x01, 0x00, Events.FinishConnection, null, {}));
                        break;
                    case Events.ConnectionFinished: {
                        clearTimeout(timeout);
                        ws.close();
                        if (audioChunks.length === 0) {
                            reject(new Error('TTS 未返回音频数据'));
                            return;
                        }

                        const audioBuffer = Buffer.concat(audioChunks);
                        const filename = `tts_${Date.now()}.${this.config.encoding}`;
                        const filepath = path.join(AUDIO_DIR, filename);
                        fs.writeFileSync(filepath, audioBuffer);
                        this.cleanupAudio();
                        console.log('[TTS Doubao] 音频已保存:', filepath, `(${audioBuffer.length} bytes)`);
                        resolve(filepath);
                        break;
                    }
                    default:
                        break;
                }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`TTS WebSocket 错误: ${err.message}`));
            });

            ws.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }

    async synthesizeWithMinimax(text) {
        const baseUrl = this.getResolvedBaseUrl();
        const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model: this.config.modelId,
                text,
                stream: false,
                output_format: 'hex',
                voice_setting: {
                    voice_id: this.config.voiceId,
                    speed: this.config.speed,
                    vol: this.config.volume,
                    pitch: Math.round(this.config.pitch || 0)
                },
                audio_setting: {
                    format: this.config.encoding
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Minimax TTS 请求失败: HTTP ${response.status} ${errorText}`);
        }

        const payload = await response.json();
        if (payload?.base_resp?.status_code && payload.base_resp.status_code !== 0) {
            throw new Error(`Minimax TTS 请求失败: ${payload.base_resp.status_msg || payload.base_resp.status_code}`);
        }
        const audioBase64 = payload?.data?.audio || payload?.audio || payload?.data?.audio_base64;
        if (!audioBase64) {
            throw new Error('Minimax TTS 返回中没有音频数据');
        }

        const audioBuffer = Buffer.from(audioBase64, 'hex');
        const filename = `tts_${Date.now()}.${this.config.encoding}`;
        const filepath = path.join(AUDIO_DIR, filename);
        fs.writeFileSync(filepath, audioBuffer);
        this.cleanupAudio();
        console.log('[TTS Minimax] 音频已保存:', filepath, `(${audioBuffer.length} bytes)`);
        return filepath;
    }
    
    /**
     * 清理旧音频文件（按过期时间 + 最大数量双重限制）
     */
    cleanupAudio() {
        if (!fs.existsSync(AUDIO_DIR)) return;

        const now = Date.now();
        const files = fs.readdirSync(AUDIO_DIR)
            .filter((f) => f.startsWith('tts_'))
            .map((f) => ({
                name: f,
                path: path.join(AUDIO_DIR, f),
                time: fs.statSync(path.join(AUDIO_DIR, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        for (const file of files) {
            if (now - file.time > TTS_MAX_CACHE_AGE_MS) {
                fs.unlinkSync(file.path);
                console.log('[TTS] 清理过期音频:', file.name);
            }
        }

        const remainingFiles = fs.readdirSync(AUDIO_DIR)
            .filter((f) => f.startsWith('tts_'))
            .map((f) => ({
                name: f,
                path: path.join(AUDIO_DIR, f),
                time: fs.statSync(path.join(AUDIO_DIR, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (remainingFiles.length > TTS_MAX_CACHE_FILES) {
            remainingFiles.slice(TTS_MAX_CACHE_FILES).forEach((file) => {
                fs.unlinkSync(file.path);
                console.log('[TTS] 清理超量音频:', file.name);
            });
        }
    }
}

/**
 * 解析文本中的 [voice:...] 标签
 * 支持半角方括号 [voice:...] 和全角方括号 ［voice:...］
 * @param {string} text - 原始文本
 * @returns {{ textParts: Array<{type: 'text'|'voice', content: string}>, hasVoice: boolean }}
 */
export function parseVoiceTags(text) {
    const parts = [];
    // 同时匹配半角 [] 和全角 ［］ 方括号
    const regex = /[\[［]voice[：:]\s*([^\]］]+)[\]］]/gi;
    let lastIndex = 0;
    let match;
    let hasVoice = false;
    
    while ((match = regex.exec(text)) !== null) {
        // 添加 voice 标签之前的文本
        if (match.index > lastIndex) {
            const textBefore = text.substring(lastIndex, match.index).trim();
            if (textBefore) {
                parts.push({ type: 'text', content: textBefore });
            }
        }
        
        // 添加 voice 内容
        parts.push({ type: 'voice', content: match[1].trim() });
        hasVoice = true;
        lastIndex = match.index + match[0].length;
    }
    
    // 添加最后剩余的文本
    if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex).trim();
        if (remaining) {
            parts.push({ type: 'text', content: remaining });
        }
    }
    
    // 如果没有任何 voice 标签，返回原文本作为纯文本
    if (parts.length === 0) {
        parts.push({ type: 'text', content: text });
    }
    
    return { textParts: parts, hasVoice };
}

/**
 * 可用音色列表 - 豆包语音合成2.0
 * 文档: https://www.volcengine.com/docs/6561/1257544
 */
export const VOICE_TYPES = {
    // === 多情感大模型（推荐）===
    'zh_female_tianmeixiaoyuan_moon_bigtts': '甜美小源(多情感)',
    'zh_male_chunhouzhubo_moon_bigtts': '醇厚主播(多情感)',
    'zh_female_shuangkuaisisi_moon_bigtts': '爽快思思(多情感)',
    'zh_male_yangguangqingnian_moon_bigtts': '阳光青年(多情感)',
    
    // === 通用场景 - 中文女声 ===
    'zh_female_tianmeixiaoyuan': '甜美小源',
    'zh_female_shuangkuaisisi': '爽快思思',
    'zh_female_wanwanxiaohe': '湾湾小何',
    'zh_female_qingcheyouni': '清澈悠尼',
    'zh_female_gaolengyujie': '高冷御姐',
    'zh_female_sajiaonvyou': '撒娇女友',
    'zh_female_yuanqinvhai': '元气女孩',
    
    // === 通用场景 - 中文男声 ===
    'zh_male_chunhouzhubo': '醇厚主播',
    'zh_male_yangguangqingnian': '阳光青年',
    'zh_male_wenzhidianshang': '稳重电商',
    'zh_male_qingshuangdege': '清爽德哥',
    'zh_male_shaonianzixin': '少年子鑫',
    
    // === 有声阅读 ===
    'zh_female_linjianvhai': '邻家女孩',
    'zh_male_shaonianxiaoxiao': '少年萧萧',
    'zh_female_yuehangyuan': '悦航员',
    
    // === 方言 ===
    'zh_female_sichuan': '四川妹子',
    'zh_male_dongbei': '东北老铁',
    'zh_female_taiwan': '台湾甜妹',
    
    // === 英文 ===
    'en_female_sarah': 'Sarah(英文女声)',
    'en_male_adam': 'Adam(英文男声)',
    
    // === 日文 ===
    'jp_female_mai': 'Mai(日文女声)',
    'jp_male_kenta': 'Kenta(日文男声)',
};

function normalizeTTSConfig(options = {}) {
    return {
        enabled: options.enabled === true,
        provider: options.provider || 'doubao',
        baseUrl: options.baseUrl || '',
        apiKey: options.apiKey || options.accessToken || options.token || '',
        modelId: options.modelId || options.model || '',
        voiceId: options.voiceId || options.voiceType || 'zh_female_shuangkuaisisi_moon_bigtts',
        speed: options.speed ?? options.speedRatio ?? 1.0,
        volume: options.volume ?? options.volumeRatio ?? 1.0,
        pitch: options.pitch ?? options.pitchRatio ?? 1.0,
        appId: options.appId || options.appid || '',
        encoding: options.encoding || 'mp3'
    };
}
