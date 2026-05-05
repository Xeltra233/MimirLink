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

    if (analysisMode === 'messages_only') {
        return `请基于以下真实聊天内容更新人物档案。仅允许依据这些新增消息总结，不要臆测未出现的信息。\n\n新增消息如下：\n${messageText}\n\n输出格式：\n稳定画像: ...\n当前状态: ...`;
    }

    const priorProfile = source.existing?.content || '无';
    return `请基于以下真实聊天内容增量更新人物档案。已有档案如下：\n${priorProfile}\n\n新增消息如下：\n${messageText}\n\n输出格式：\n稳定画像: ...\n当前状态: ...`;
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
