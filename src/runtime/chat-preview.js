import { resolveChatRuntimeInputs } from './source-resolver.js';
import { buildAIToolContext, buildToolPhaseMessages } from '../tools.js';

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

    // 两阶段预览：展示工具阶段（轻提示词 + 工具）与正式回复阶段的拆分
    const toolPhaseEnabled = services.config?.chat?.toolPhase?.enabled !== false;
    const toolContext = buildAIToolContext({
        config: services.config || {},
        logger: null,
        mcpClient: services.mcpClient || null
    });
    const hasAvailableTools = Array.isArray(toolContext.tools) && toolContext.tools.length > 0;
    const toolPhasePreview = toolPhaseEnabled
        ? {
            enabled: true,
            hasTools: hasAvailableTools,
            toolNames: toolContext.tools.map((tool) => tool?.function?.name).filter(Boolean),
            toolHints: toolContext.toolHints,
            messages: hasAvailableTools ? buildToolPhaseMessages(built.messages, toolContext.toolHints, { characterName: resolved.character?.name || input.characterName || '' }) : []
        }
        : { enabled: false, hasTools: hasAvailableTools, toolNames: [], toolHints: [], messages: [] };

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
        twoPhase: toolPhasePreview,
        messages: built.messages
    };
}
