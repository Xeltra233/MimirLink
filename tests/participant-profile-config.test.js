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
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret-key',
        retryOnError: false
    });
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
        baseUrl: 'https://example.test/v1',
        apiKey: 'token',
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
        baseUrl: 'https://example.test/v1',
        apiKey: 'token',
        retryOnError: false
    });
});
