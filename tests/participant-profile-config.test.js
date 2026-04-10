import test from 'node:test';
import assert from 'node:assert/strict';

import { getParticipantProfileConfig } from '../src/participant-profile-config.js';

test('participant profile config falls back to default threshold and idle time', () => {
    const config = {};

    assert.deepEqual(getParticipantProfileConfig(config), {
        threshold: 8,
        idleMs: 2 * 60 * 1000,
        sourceMessageLimit: 50
    });
});

test('participant profile config prefers configured values', () => {
    const config = {
        memory: {
            participantProfile: {
                triggerMessages: 12,
                idleMs: 45_000,
                maxSourceMessages: 30
            }
        }
    };

    assert.deepEqual(getParticipantProfileConfig(config), {
        threshold: 12,
        idleMs: 45_000,
        sourceMessageLimit: 30
    });
});

test('participant profile config ignores invalid values and keeps defaults', () => {
    const config = {
        memory: {
            participantProfile: {
                triggerMessages: 0,
                idleMs: -1,
                maxSourceMessages: 'bad'
            }
        }
    };

    assert.deepEqual(getParticipantProfileConfig(config), {
        threshold: 8,
        idleMs: 2 * 60 * 1000,
        sourceMessageLimit: 50
    });
});
