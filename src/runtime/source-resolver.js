import { PromptBuilder } from '../prompt.js';

function hasValue(value) {
    if (Array.isArray(value)) {
        return value.length > 0;
    }

    if (value && typeof value === 'object') {
        return Object.keys(value).length > 0;
    }

    return value !== null && value !== undefined && value !== '';
}

function resolveBindingTrace(config = {}, characterName) {
    PromptBuilder.ensureBindingConfig(config);
    const binding = PromptBuilder.getCharacterBinding(config, characterName);
    const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
    const regexResolution = PromptBuilder.getRegexResolution(config, characterName);

    const resolveSource = (explicitValue, importedValue, globalValue, legacyValue) => {
        if (hasValue(explicitValue)) return 'character_binding';
        if (hasValue(importedValue)) return 'imported_from_card';
        if (hasValue(globalValue)) return 'global';
        if (hasValue(legacyValue)) return 'legacy';
        return 'none';
    };

    return {
        worldbook: {
            source: resolveSource(binding.worldbook, binding.importedFromCard?.worldbook, config.bindings.global.worldbook, null),
            value: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null
        },
        preset: {
            source: presetResolution.source,
            value: presetResolution.preset?.name || null,
            layers: presetResolution.layers,
            lockedIdentifiers: presetResolution.lockedIdentifiers,
            itemSources: presetResolution.itemSources
        },
        regexRules: {
            source: regexResolution.regexRules.source,
            count: regexResolution.regexRules.count
        },
        presetRegexRules: {
            source: regexResolution.presetRegexRules.source,
            layers: regexResolution.presetRegexRules.layers,
            count: regexResolution.presetRegexRules.count
        },
        globalRegexRules: {
            source: regexResolution.globalRegexRules.source,
            count: regexResolution.globalRegexRules.count
        }
    };
}

export function resolveChatRuntimeInputs({ characterName, config = {}, characterManager, worldBookManager }) {
    const effectiveBinding = PromptBuilder.getEffectiveBinding(config, characterName);
    const bindingTrace = resolveBindingTrace(config, characterName);
    const character = characterManager.readFromPng(characterName);

    let worldBook = null;
    if (effectiveBinding.worldbook) {
        worldBook = worldBookManager.readWorldBook(effectiveBinding.worldbook);
    } else if (worldBookManager.currentWorldBook) {
        worldBook = worldBookManager.currentWorldBook;
    }

    const preset = PromptBuilder.normalizePreset(effectiveBinding.preset || config.preset || {});

    return {
        effectiveBinding,
        bindingTrace,
        character,
        worldBook,
        preset
    };
}
