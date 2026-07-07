export function getParticipantProfileTimerKey(namespaceOptions, speakerIdentity) {
    return [
        speakerIdentity?.participantId || '',
        namespaceOptions?.scopeType || '',
        namespaceOptions?.scopeKey || '',
        namespaceOptions?.characterName || '',
        namespaceOptions?.presetName || ''
    ].join('|');
}

export function buildParticipantProfileTaskMeta(namespaceOptions, speakerIdentity) {
    return {
        taskKey: getParticipantProfileTimerKey(namespaceOptions, speakerIdentity),
        participantId: String(speakerIdentity?.participantId || ''),
        participantName: speakerIdentity?.participantName || String(speakerIdentity?.participantId || ''),
        scopeType: namespaceOptions?.scopeType || null,
        scopeKey: namespaceOptions?.scopeKey || null,
        characterName: namespaceOptions?.characterName || null,
        presetName: namespaceOptions?.presetName || null
    };
}

export function trackParticipantProfileTarget(targets, namespaceOptions, speakerIdentity) {
    if (!speakerIdentity?.participantId) {
        return null;
    }

    const timerKey = getParticipantProfileTimerKey(namespaceOptions, speakerIdentity);
    targets.set(timerKey, {
        namespaceOptions: { ...namespaceOptions },
        speakerIdentity: { ...speakerIdentity }
    });
    return timerKey;
}

export function shouldUseIdleParticipantProfileTrigger(participantProfileConfig) {
    return participantProfileConfig.triggerMode === 'idle' || participantProfileConfig.triggerMode === 'both';
}

export function shouldUseIntervalParticipantProfileTrigger(participantProfileConfig) {
    return participantProfileConfig.triggerMode === 'interval' || participantProfileConfig.triggerMode === 'both';
}

export function buildParticipantProfilePrompt(source, analysisMode) {
    const messageText = source.messages
        .map((item) => `[${item.sessionId}] ${item.role}: ${item.content}`)
        .join('\n');

    const isBotOnly = analysisMode === 'bot_only_messages' || analysisMode === 'bot_only_profile';
    const isMessagesOnly = analysisMode === 'messages_only' || analysisMode === 'bot_only_messages';

    const scopeHint = isBotOnly ? '（以下仅包含用户与 Bot 的直接对话记录，不含第三方聊天）\n' : '';

    if (isMessagesOnly) {
        return `${scopeHint}请基于以下真实聊天内容更新人物档案。仅允许依据这些新增消息总结，不要臆测未出现的信息。\n\n新增消息如下：\n${messageText}\n\n输出格式：\n稳定画像: ...\n当前状态: ...`;
    }

    const priorProfile = source.existing?.content || '无';
    return `${scopeHint}请基于以下真实聊天内容增量更新人物档案。已有档案如下：\n${priorProfile}\n\n新增消息如下：\n${messageText}\n\n输出格式：\n稳定画像: ...\n当前状态: ...`;
}

export function buildParticipantProfileMergePrompt({ participantId = '', participantName = '', oldProfile = '', newProfile = '' } = {}) {
    return [
        '请合并同一个 QQ 用户的人物档案。',
        `QQ：${participantId || '-'}`,
        `当前昵称：${participantName || participantId || '-'}`,
        '',
        '要求：',
        '1. 只保留一个最终档案，不要输出两个版本，也不要解释合并过程。',
        '2. 以新版本中的最新状态为准，但不要丢掉旧档案里仍稳定、未被新版本推翻的信息。',
        '3. 删除重复、冲突、空泛和模型自述内容；冲突处按“新版本 > 旧档案”，无法判断时写成不确定或省略。',
        '4. 不要编造聊天记录中没有出现的信息。',
        '5. 输出纯文本人物档案，建议包含“稳定画像”和“当前状态”两段。',
        '',
        '旧档案：',
        String(oldProfile || '').trim() || '无',
        '',
        '新版本：',
        String(newProfile || '').trim() || '无'
    ].join('\n');
}

export function buildParticipantProfileAIOverrides(participantProfileConfig) {
    const overrides = {};
    if (participantProfileConfig.model) {
        overrides.model = participantProfileConfig.model;
    }
    if (participantProfileConfig.baseUrl) {
        overrides.baseUrl = participantProfileConfig.baseUrl;
    }
    if (participantProfileConfig.apiKey) {
        overrides.apiKey = participantProfileConfig.apiKey;
    }
    return overrides;
}
