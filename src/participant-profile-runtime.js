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

export function resolveParticipantProfilePromptSpeakerLabel(item = {}, speakerIdentity = null) {
    const speakerType = String(item?.speakerType || '').trim().toLowerCase();
    const speakerId = String(item?.speakerId || item?.metadata?.userId || '').trim();
    const speakerName = String(item?.speakerName || item?.metadata?.participantName || '').trim();
    const targetId = String(speakerIdentity?.participantId || '').trim();
    const targetName = String(speakerIdentity?.participantName || targetId || '目标人物').trim();

    if (speakerType === 'target' || (targetId && speakerId && speakerId === targetId)) {
        return `目标人物|${speakerName || targetName}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    if (speakerType === 'bot' || String(item?.role || '').toLowerCase() === 'assistant') {
        return 'Bot';
    }
    if (speakerType === 'third_party') {
        return `第三者|${speakerName || '群友'}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    if (String(item?.role || '').toLowerCase() === 'user') {
        return `其他用户|${speakerName || speakerId || '未知'}${speakerId ? `|QQ:${speakerId}` : ''}`;
    }
    return `未知说话人|${speakerName || speakerId || item?.role || 'unknown'}`;
}

export function formatParticipantProfilePromptMessage(item = {}, speakerIdentity = null) {
    const sessionId = item?.sessionId || '-';
    const speakerLabel = resolveParticipantProfilePromptSpeakerLabel(item, speakerIdentity);
    const ownContent = String(item?.content || '').trim() || '（空）';
    const lines = [`[${sessionId}] [说话人:${speakerLabel}] ${ownContent}`];

    const quotes = Array.isArray(item?.quotes) && item.quotes.length > 0
        ? item.quotes
        : (item?.quote ? [item.quote] : []);
    for (const quote of quotes) {
        const quoteName = String(quote?.speakerName || '').trim();
        const quoteId = String(quote?.speakerId || '').trim();
        const quoteContent = String(quote?.content || '').trim();
        if (!quoteContent) {
            continue;
        }
        const who = [quoteName || '被引用者', quoteId ? `QQ:${quoteId}` : ''].filter(Boolean).join('|');
        lines.push(`  引用原文(仅背景，不是本人发言，来自:${who}): ${quoteContent}`);
    }

    return lines.join('\n');
}

export function buildParticipantProfilePrompt(source = {}, analysisMode, speakerIdentity = null) {
    const targetId = String(
        speakerIdentity?.participantId
        || source?.participantId
        || source?.targetParticipantId
        || source?.existing?.participantId
        || source?.existing?.metadata?.participantId
        || ''
    ).trim();
    const targetName = String(
        speakerIdentity?.participantName
        || source?.participantName
        || source?.targetParticipantName
        || source?.existing?.participantName
        || source?.existing?.metadata?.participantName
        || targetId
        || '目标人物'
    ).trim();

    const identity = {
        participantId: targetId,
        participantName: targetName
    };

    const messages = Array.isArray(source?.messages) ? source.messages : [];
    const messageText = messages.length > 0
        ? messages.map((item) => formatParticipantProfilePromptMessage(item, identity)).join('\n')
        : '（无新增消息）';

    const isBotOnly = analysisMode === 'bot_only_messages' || analysisMode === 'bot_only_profile';
    const isMessagesOnly = analysisMode === 'messages_only' || analysisMode === 'bot_only_messages';

    const rules = [
        '归因硬约束：',
        `1. 档案只描述目标人物：${targetName}${targetId ? `（QQ:${targetId}）` : ''}。`,
        '2. 必须把说话人掰开：目标人物 / Bot / 第三者；不得把 Bot 或第三者的话写成目标人物说的。',
        '3. 标记为“引用原文”的内容只作背景，不可记为目标人物观点、口头禅、性格或行为。',
        '4. 目标人物的稳定画像与当前状态，只能依据“说话人=目标人物”的本人发言归纳。',
        '5. Bot 与第三者内容可以用于理解语境，但禁止写入成目标人物自己的表达。',
        '6. 不要臆测未出现的信息；冲突时宁可写不确定或省略。'
    ].join('\n');

    const scopeHint = isBotOnly
        ? '范围说明：以下优先包含目标人物与 Bot 的交互上下文；其中 Bot 发言仅作背景，不是目标人物本人发言。\n'
        : '范围说明：以下包含目标人物锚点附近的对话上下文，请按说话人标签拆开理解。\n';

    const header = [
        `请基于以下真实聊天内容${isMessagesOnly ? '更新' : '增量更新'}人物档案。`,
        `目标人物：${targetName}${targetId ? `（QQ:${targetId}）` : ''}`,
        rules,
        scopeHint.trim()
    ].join('\n');

    if (isMessagesOnly) {
        return [
            header,
            '',
            '仅允许依据这些新增消息总结，不要臆测未出现的信息。',
            '新增消息如下：',
            messageText,
            '',
            '输出格式：',
            '稳定画像: ...',
            '当前状态: ...'
        ].join('\n');
    }

    const priorProfile = String(source?.existing?.content || '').trim() || '无';
    return [
        header,
        '',
        '已有档案如下：',
        priorProfile,
        '',
        '新增消息如下：',
        messageText,
        '',
        '输出格式：',
        '稳定画像: ...',
        '当前状态: ...'
    ].join('\n');
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
