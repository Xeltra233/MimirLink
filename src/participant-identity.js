function cleanText(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeId(value) {
    return cleanText(value);
}

function toOneBotId(value) {
    const text = normalizeId(value);
    return /^\d+$/.test(text) ? Number(text) : text;
}

function uniqueNonEmpty(values = []) {
    return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function firstText(source = {}, keys = []) {
    for (const key of keys) {
        const value = cleanText(source?.[key]);
        if (value) {
            return value;
        }
    }
    return '';
}

function buildIdentity({ participantId, participantName, source, groupId = '', raw = null, timestamp = null, messageType = null }) {
    const normalizedParticipantId = normalizeId(participantId);
    const normalizedName = cleanText(participantName);
    if (!normalizedParticipantId || !normalizedName) {
        return null;
    }

    return {
        participantId: normalizedParticipantId,
        participantName: normalizedName,
        source,
        groupId: cleanText(groupId) || null,
        raw,
        timestamp,
        messageType
    };
}

function pickGlobalName(info = {}) {
    return firstText(info, ['remark', 'nickname', 'name', 'card']);
}

function pickFriendName(info = {}) {
    return firstText(info, ['remark', 'nickname', 'name', 'card']);
}

function pickGroupName(info = {}) {
    return firstText(info, ['card', 'nickname', 'name', 'title']);
}

async function callOptional(bot, methodName, args = [], logger = null) {
    if (!bot || typeof bot[methodName] !== 'function') {
        return null;
    }

    try {
        return await bot[methodName](...args);
    } catch (error) {
        logger?.debug?.(`[QQ身份] ${methodName} 查询失败: ${error.message}`);
        return null;
    }
}

async function resolveFromFriendList(bot, participantId, logger) {
    const friends = await callOptional(bot, 'getFriendList', [], logger);
    if (!Array.isArray(friends)) {
        return null;
    }

    const target = friends.find((item) => normalizeId(item?.user_id ?? item?.userId ?? item?.uin) === participantId);
    if (!target) {
        return null;
    }

    return buildIdentity({
        participantId,
        participantName: pickFriendName(target),
        source: 'qq_friend_list',
        raw: target,
        messageType: 'private'
    });
}

async function resolveFromGroupMemberList(bot, participantId, groupId, logger) {
    const members = await callOptional(bot, 'getGroupMemberList', [groupId], logger);
    if (!Array.isArray(members)) {
        return null;
    }

    const target = members.find((item) => normalizeId(item?.user_id ?? item?.userId ?? item?.uin) === participantId);
    if (!target) {
        return null;
    }

    return buildIdentity({
        participantId,
        participantName: pickGroupName(target),
        source: 'qq_group_member_list',
        groupId,
        raw: target,
        messageType: 'group'
    });
}

export function collectParticipantGroupIds(...values) {
    const flattened = [];
    for (const value of values) {
        if (Array.isArray(value)) {
            flattened.push(...value);
        } else {
            flattened.push(value);
        }
    }
    return uniqueNonEmpty(flattened);
}

export async function resolveParticipantIdentityFromOneBot(bot, participantId, options = {}) {
    const normalizedParticipantId = normalizeId(participantId);
    if (!normalizedParticipantId) {
        return null;
    }

    const logger = options.logger || null;
    const groupIds = collectParticipantGroupIds(options.groupId, options.groupIds);

    const strangerInfo = await callOptional(bot, 'getStrangerInfo', [normalizedParticipantId, true], logger);
    const globalIdentity = buildIdentity({
        participantId: normalizedParticipantId,
        participantName: pickGlobalName(strangerInfo || {}),
        source: 'qq_global_info',
        raw: strangerInfo,
        messageType: options.messageType || null
    });
    if (globalIdentity) {
        return globalIdentity;
    }

    if (groupIds.length === 0) {
        const friendIdentity = await resolveFromFriendList(bot, normalizedParticipantId, logger);
        if (friendIdentity) {
            return friendIdentity;
        }
    }

    for (const groupId of groupIds) {
        const memberInfo = await callOptional(bot, 'getGroupMemberInfo', [groupId, normalizedParticipantId, true], logger);
        const memberIdentity = buildIdentity({
            participantId: normalizedParticipantId,
            participantName: pickGroupName(memberInfo || {}),
            source: 'qq_group_member_info',
            groupId,
            raw: memberInfo,
            messageType: 'group'
        });
        if (memberIdentity) {
            return memberIdentity;
        }

        const listIdentity = await resolveFromGroupMemberList(bot, normalizedParticipantId, groupId, logger);
        if (listIdentity) {
            return listIdentity;
        }
    }

    return resolveFromFriendList(bot, normalizedParticipantId, logger);
}

export function mergeParticipantIdentity(baseIdentity = {}, resolvedIdentity = null) {
    if (!resolvedIdentity?.participantName) {
        return baseIdentity;
    }

    return {
        ...baseIdentity,
        participantId: normalizeId(resolvedIdentity.participantId || baseIdentity.participantId),
        participantName: resolvedIdentity.participantName,
        groupId: resolvedIdentity.groupId || baseIdentity.groupId || null,
        messageType: resolvedIdentity.messageType || baseIdentity.messageType || null,
        identitySource: resolvedIdentity.source || baseIdentity.identitySource || null
    };
}

export { toOneBotId };
