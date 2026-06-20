import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Logger } from '../src/logger.js';

test('logger removes only expired log files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-logs-'));
    const oldLog = path.join(tempDir, 'mimirlink-2026-01-01.log');
    const recentLog = path.join(tempDir, 'mimirlink-2026-01-02.log');
    const noteFile = path.join(tempDir, 'notes.txt');

    fs.writeFileSync(oldLog, 'old', 'utf8');
    fs.writeFileSync(recentLog, 'recent', 'utf8');
    fs.writeFileSync(noteFile, 'keep', 'utf8');

    const now = Date.now();
    fs.utimesSync(oldLog, new Date(now - 3 * 24 * 60 * 60 * 1000), new Date(now - 3 * 24 * 60 * 60 * 1000));
    fs.utimesSync(recentLog, new Date(now - 12 * 60 * 60 * 1000), new Date(now - 12 * 60 * 60 * 1000));

    const logger = new Logger({
        logDir: tempDir,
        logRetentionDays: 0,
        logCleanupIntervalMs: 60 * 1000
    });
    logger.level = 'error';
    logger.logRetentionDays = 1;

    const result = logger.cleanupExpiredLogs(now);
    clearInterval(logger.cleanupTimer);

    assert.equal(fs.existsSync(oldLog), false);
    assert.equal(fs.existsSync(recentLog), true);
    assert.equal(fs.existsSync(noteFile), true);
    assert.ok(fs.existsSync(logger.logFile));
    assert.equal(result.deleted, 1);
});
