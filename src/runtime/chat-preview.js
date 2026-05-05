import { resolveChatRuntimeInputs } from './source-resolver.js';

export async function buildChatRuntimePreview(input = {}, services = {}) {
    const normalizedContext = input.context || { recentMessages: [], summaries: [] };
    const resolved = resolveChatRuntimeInputs({
        characterName: input.characterName,
        config: services.config,
        characterManager: services.characterManager,
        worldBookManager: services.worldBookManager
    });

    const built = await services.promptBuilder.build(
        input.characterName,
        input.userMessage || '',
        normalizedContext,
        input.stickyKeys || new Set(),
        input.runtimeContext || {},
        {
            character: resolved.character,
            worldBook: resolved.worldBook,
            presetConfig: resolved.preset
        }
    );

    return {
        effectiveBinding: resolved.effectiveBinding,
        bindingTrace: resolved.bindingTrace,
        character: {
            name: resolved.character?.name || input.characterName || ''
        },
        worldBook: resolved.worldBook ? { name: resolved.worldBook.name || null } : null,
        sources: built.runtimeSources || [],
        runtimeComposition: built.runtimeComposition || null,
        messageTrace: built.messageTrace || [],
        messages: built.messages
    };
}
