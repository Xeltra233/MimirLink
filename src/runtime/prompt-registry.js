function resolveRuntimeSourceSlot(source = {}) {
    const placement = source.meta?.placement || 'system';

    if (placement === 'history') {
        return 'history';
    }

    if (placement === 'history_injection') {
        return 'in_chat';
    }

    if (placement === 'post_history') {
        return 'post_history';
    }

    if (placement === 'user_input') {
        return 'user_input';
    }

    if (placement === 'assistant_prefill') {
        return 'assistant_prefill';
    }

    if (placement === 'assistant_opening') {
        return 'assistant_opening';
    }

    return 'system';
}

export function createRuntimeSource({
    id,
    kind,
    label,
    content = '',
    enabled = true,
    meta = {},
    stage = 'runtime',
    order = 0
} = {}) {
    const normalizedSource = {
        id: String(id || '').trim(),
        kind: String(kind || 'unknown').trim(),
        label: String(label || '').trim(),
        content: typeof content === 'string' ? content : '',
        enabled: enabled !== false,
        meta: meta && typeof meta === 'object' ? meta : {},
        stage: String(stage || 'runtime').trim(),
        order: Number.isFinite(order) ? order : 0
    };

    return {
        ...normalizedSource,
        sourceSlot: resolveRuntimeSourceSlot(normalizedSource)
    };
}

export function compactRuntimeSources(sources = []) {
    return sources
        .filter((item) => item && item.enabled !== false && String(item.content || '').trim())
        .sort((left, right) => {
            const orderDelta = (left.order || 0) - (right.order || 0);
            if (orderDelta !== 0) {
                return orderDelta;
            }

            return String(left.id || '').localeCompare(String(right.id || ''));
        });
}
