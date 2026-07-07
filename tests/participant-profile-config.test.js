import test from 'node:test';
import assert from 'node:assert/strict';

import { getParticipantProfileConfig, normalizeParticipantProfileConfig } from '../src/participant-profile-config.js';

test('participant profile config falls back to default threshold and idle time', () => {
    const config = {};

    assert.deepEqual(getParticipantProfileConfig(config), {
        enabled: false,
        injectEnabled: true,
        blacklistParticipantIds: [],
        manualCommand: '/人物档案',
        threshold: 8,
        idleMs: 2 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        sourceMessageLimit: 50,
        triggerMode: 'idle',
        analysisMode: 'bot_only_profile',
        model: '',
        baseUrl: '',
        apiKey: '',
        retryOnError: true
    });
});

test('participant profile config prefers configured values', () => {
    const config = {
        memory: {
            participantProfile: {
                enabled: true,
                injectEnabled: false,
                blacklistParticipantIds: [' user-a ', 10001, '', 'user-a', 'user-b '],
                manualCommand: ' 手动刷新档案 ',
                triggerMessages: 12,
                idleMs: 45_000,
                intervalMs: 90_000,
                maxSourceMessages: 30,
                triggerMode: 'both',
                analysisMode: 'messages_only',
                model: 'profile-model',
                baseUrl: ' https://example.test/v1 ',
                apiKey: ' secret-key ',
                retryOnError: false
            }
        }
    };

    assert.deepEqual(getParticipantProfileConfig(config), {
        enabled: true,
        injectEnabled: false,
        blacklistParticipantIds: ['user-a', '10001', 'user-b'],
        manualCommand: '手动刷新档案',
        threshold: 12,
        idleMs: 45_000,
        intervalMs: 90_000,
        sourceMessageLimit: 30,
        triggerMode: 'both',
        analysisMode: 'messages_only',
        model: 'profile-model',
        baseUrl: '',
        apiKey: '',
        retryOnError: false
    });
});

test('participant profile provider credentials override stale profile api fields', () => {
    const config = {
        ai: {
            providers: [
                {
                    id: 'cloud-main',
                    model: 'chat-model',
                    baseUrl: 'https://current.example/v1',
                    apiKey: 'current-key'
                }
            ]
        },
        memory: {
            participantProfile: {
                providerId: 'cloud-main',
                model: 'chat-model',
                baseUrl: 'https://stale.example/v1',
                apiKey: 'stale-key'
            }
        }
    };

    assert.deepEqual(getParticipantProfileConfig(config), {
        enabled: false,
        injectEnabled: true,
        blacklistParticipantIds: [],
        manualCommand: '/人物档案',
        threshold: 8,
        idleMs: 2 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        sourceMessageLimit: 50,
        triggerMode: 'idle',
        analysisMode: 'bot_only_profile',
        model: 'chat-model',
        baseUrl: 'https://current.example/v1',
        apiKey: 'current-key',
        retryOnError: true,
        providerId: 'cloud-main'
    });
});

test('participant profile config falls back to chat or active provider without dedicated credentials', () => {
    const config = {
        chat: {
            modelProviderId: 'chat-provider',
            model: 'chat-model'
        },
        ai: {
            activeProviderId: 'active-provider',
            providers: [
                {
                    id: 'chat-provider',
                    model: 'chat-provider-model',
                    baseUrl: 'https://chat.example/v1',
                    apiKey: 'chat-key'
                },
                {
                    id: 'active-provider',
                    model: 'active-model',
                    baseUrl: 'https://active.example/v1',
                    apiKey: 'active-key'
                }
            ]
        },
        memory: {
            participantProfile: {
                model: ''
            }
        }
    };

    const normalized = getParticipantProfileConfig(config);

    assert.equal(normalized.providerId, 'chat-provider');
    assert.equal(normalized.model, 'chat-provider-model');
    assert.equal(normalized.baseUrl, 'https://chat.example/v1');
    assert.equal(normalized.apiKey, 'chat-key');
});

test('participant profile config ignores invalid values and keeps defaults', () => {
    const config = {
        memory: {
            participantProfile: {
                enabled: 'yes',
                injectEnabled: 'no',
                blacklistParticipantIds: 'bad',
                manualCommand: '   ',
                triggerMessages: 0,
                idleMs: -1,
                intervalMs: 'bad',
                maxSourceMessages: 'bad',
                triggerMode: 'later',
                analysisMode: 'full',
                model: 123,
                baseUrl: null,
                apiKey: false,
                retryOnError: 'no'
            }
        }
    };

    assert.deepEqual(getParticipantProfileConfig(config), {
        enabled: false,
        injectEnabled: true,
        blacklistParticipantIds: [],
        manualCommand: '/人物档案',
        threshold: 8,
        idleMs: 2 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        sourceMessageLimit: 50,
        triggerMode: 'idle',
        analysisMode: 'bot_only_profile',
        model: '',
        baseUrl: '',
        apiKey: '',
        retryOnError: true
    });
});

test('normalize participant profile config writes normalized values back to config', () => {
    const config = {
        memory: {
            participantProfile: {
                enabled: true,
                injectEnabled: false,
                blacklistParticipantIds: [' user-a ', 10086, '', '10086'],
                manualCommand: '  ',
                triggerMessages: '10',
                idleMs: 60000,
                intervalMs: 'oops',
                maxSourceMessages: 20,
                triggerMode: 'interval',
                analysisMode: 'messages_only',
                model: ' profile-model ',
                baseUrl: ' https://example.test/v1 ',
                apiKey: ' token ',
                retryOnError: false
            }
        }
    };

    const normalized = normalizeParticipantProfileConfig(config);

    assert.deepEqual(normalized, {
        enabled: true,
        injectEnabled: false,
        blacklistParticipantIds: ['user-a', '10086'],
        manualCommand: '/人物档案',
        threshold: 10,
        idleMs: 60000,
        intervalMs: 5 * 60 * 1000,
        sourceMessageLimit: 20,
        triggerMode: 'interval',
        analysisMode: 'messages_only',
        model: 'profile-model',
        baseUrl: '',
        apiKey: '',
        retryOnError: false
    });

    assert.deepEqual(config.memory.participantProfile, {
        enabled: true,
        injectEnabled: false,
        blacklistParticipantIds: ['user-a', '10086'],
        manualCommand: '/人物档案',
        triggerMessages: 10,
        idleMs: 60000,
        intervalMs: 5 * 60 * 1000,
        maxSourceMessages: 20,
        triggerMode: 'interval',
        analysisMode: 'messages_only',
        model: 'profile-model',
        retryOnError: false
    });
});

test('normalize participant profile config removes legacy dedicated credentials on load', () => {
    const config = {
        ai: {
            providers: [{
                id: 'default',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'provider-model'
            }]
        },
        memory: {
            participantProfile: {
                providerId: 'default',
                model: 'provider-model',
                baseUrl: 'https://old-profile.example/v1',
                apiKey: 'old-profile-key'
            }
        }
    };

    const normalized = normalizeParticipantProfileConfig(config);

    assert.equal(normalized.baseUrl, 'https://provider.example/v1');
    assert.equal(normalized.apiKey, 'provider-key');
    assert.equal(config.memory.participantProfile.providerId, 'default');
    assert.equal(config.memory.participantProfile.model, 'provider-model');
    assert.equal(config.memory.participantProfile.baseUrl, undefined);
    assert.equal(config.memory.participantProfile.apiKey, undefined);
});
