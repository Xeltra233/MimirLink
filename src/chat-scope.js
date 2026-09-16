/**
 * 聊天范围过滤（与 Go 版 internal/chat/chatscope.go 同语义）：
 * global_shared 等共享会话下，模型只应看到“当前群聊 / 当前私聊”的最近消息，
 * 其他群或其他人的私聊内容不再进入上下文。
 * 用户消息元数据带 groupId；assistant 消息本版起也写 groupId，缺失时按“继承上一条用户消息的范围”处理（兼容历史数据）。
 */

const CHAT_SCOPE_HEADER_PATTERN = /\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|群号:([^|\]]*)\|群名:([^|\]]*)/;

/** 生成当前聊天的范围键：群聊 group:<群号>，私聊 private:<QQ>。 */
export function chatScopeKey({ messageType, groupId, userId } = {}) {
    if (messageType === 'group') {
        const normalizedGroupId = String(groupId || '').trim();
        if (normalizedGroupId) {
            return `group:${normalizedGroupId}`;
        }
    }
    const normalizedUserId = String(userId || '').trim();
    return normalizedUserId ? `private:${normalizedUserId}` : '';
}

/** 判断范围键是否私聊。 */
export function isPrivateChatScope(scopeKey) {
    return String(scopeKey || '').startsWith('private:');
}

/** 从结构化消息头解析聊天范围键。 */
export function headerChatScope(text) {
    const match = String(text || '').match(CHAT_SCOPE_HEADER_PATTERN);
    if (!match) {
        return '';
    }
    const [, chatLabel, qq, , groupId] = match;
    if (chatLabel === '群聊' && groupId && groupId !== 'N/A') {
        return `group:${groupId}`;
    }
    if (chatLabel === '私聊' && qq) {
        return `private:${qq}`;
    }
    return '';
}

/** 解析单条消息的聊天范围键（优先元数据 groupId，回退消息头）。 */
export function messageChatScope(message) {
    const groupId = message?.metadata?.groupId;
    if (groupId) {
        return `group:${String(groupId).trim()}`;
    }
    return headerChatScope(message?.content);
}

/** 只保留属于当前聊天范围的消息；scopeKey 为空时原样返回。 */
export function filterMessagesForChat(messages, scopeKey) {
    const list = Array.isArray(messages) ? messages : [];
    if (!scopeKey) {
        return list;
    }
    const result = [];
    let lastUserScope = '';
    for (const message of list) {
        let scope = messageChatScope(message);
        if (!scope && message?.role === 'assistant') {
            scope = lastUserScope;
        }
        if (message?.role === 'user' && scope) {
            lastUserScope = scope;
        }
        if (!scope || scope === scopeKey) {
            result.push(message);
        }
    }
    return result;
}

/** 共享会话下先按更大窗口取原始消息，过滤后再裁剪到 historyLimit。 */
export function chatScopePullLimit(historySize) {
    const size = Number(historySize) > 0 ? Number(historySize) : 30;
    return Math.min(Math.max(size * 4, 50), 400);
}
