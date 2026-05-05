/**
 * 消息调度运行时
 * 提供去重、缓冲聚合、每会话串行化与全局并发限制。
 */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.current = 0;
        this.waiters = [];
    }

    setMaxConcurrent(maxConcurrent) {
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.flush();
    }

    async acquire() {
        if (this.current < this.maxConcurrent) {
            this.current += 1;
            return;
        }

        await new Promise((resolve) => {
            this.waiters.push(resolve);
        });
        this.current += 1;
    }

    release() {
        this.current = Math.max(0, this.current - 1);
        this.flush();
    }

    flush() {
        while (this.current < this.maxConcurrent && this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter();
        }
    }
}

export class MessageRuntime {
    constructor(config, logger, processor) {
        this.logger = logger;
        this.processor = processor;
        this.buffers = new Map();
        this.chains = new Map();
        this.seenMessages = new Map();
        this.lastEnqueueAt = null;
        this.lastFlushAt = null;
        this.totalBatches = 0;
        this.updateConfig(config);
    }

    updateConfig(config = {}) {
        this.config = config;
        const chatConfig = config.chat || {};
        this.bufferWindowMs = chatConfig.bufferWindowMs ?? 1200;
        this.replyDelayMs = chatConfig.replyDelayMs ?? 800;
        this.dedupeWindowMs = chatConfig.dedupeWindowMs ?? 10000;
        const maxConcurrent = chatConfig.maxConcurrentSessions ?? 2;

        if (this.semaphore) {
            this.semaphore.setMaxConcurrent(maxConcurrent);
        } else {
            this.semaphore = new Semaphore(maxConcurrent);
        }
    }

    enqueue(item) {
        this.cleanupSeenMessages();
        if (item.dedupeKey && this.seenMessages.has(item.dedupeKey)) {
            this.logger.debug?.(`[调度] 重复消息已忽略: ${item.dedupeKey}`);
            return false;
        }

        if (item.dedupeKey) {
            this.seenMessages.set(item.dedupeKey, Date.now());
        }

        this.lastEnqueueAt = Date.now();

        const state = this.getBufferState(item.sessionKey);
        state.items.push(item);

        if (state.timer) {
            clearTimeout(state.timer);
        }

        state.timer = setTimeout(() => {
            this.flush(item.sessionKey).catch((error) => {
                this.logger.error?.(`[调度] 刷新缓冲失败: ${error.message}`);
            });
        }, this.bufferWindowMs);

        return true;
    }

    getBufferState(sessionKey) {
        if (!this.buffers.has(sessionKey)) {
            this.buffers.set(sessionKey, {
                items: [],
                timer: null
            });
        }

        return this.buffers.get(sessionKey);
    }

    async flush(sessionKey) {
        const state = this.buffers.get(sessionKey);
        if (!state || state.items.length === 0) {
            return;
        }

        const items = state.items.splice(0, state.items.length);
        this.lastFlushAt = Date.now();
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }

        const chain = (this.chains.get(sessionKey) || Promise.resolve())
            .then(() => this.runBatch(sessionKey, items))
            .catch((error) => {
                this.logger.error?.(`[调度] 会话 ${sessionKey} 批处理失败: ${error.message}`);
            });

        this.chains.set(sessionKey, chain.finally(() => {
            if (this.chains.get(sessionKey) === chain) {
                this.chains.delete(sessionKey);
            }
        }));
    }

    async runBatch(sessionKey, items) {
        await this.semaphore.acquire();
        try {
            this.totalBatches += 1;
            if (this.replyDelayMs > 0) {
                await sleep(this.replyDelayMs);
            }

            await this.processor({
                sessionKey,
                items,
                createdAt: Date.now()
            });
        } finally {
            this.semaphore.release();
        }
    }

    cleanupSeenMessages() {
        const now = Date.now();
        for (const [key, timestamp] of this.seenMessages.entries()) {
            if (now - timestamp > this.dedupeWindowMs) {
                this.seenMessages.delete(key);
            }
        }
    }

    getStats() {
        const bufferedMessages = Array.from(this.buffers.values())
            .reduce((count, state) => count + state.items.length, 0);

        return {
            bufferedSessions: this.buffers.size,
            bufferedMessages,
            activeSessions: this.chains.size,
            queuedDedupes: this.seenMessages.size,
            maxConcurrentSessions: this.semaphore.maxConcurrent,
            replyDelayMs: this.replyDelayMs,
            bufferWindowMs: this.bufferWindowMs,
            lastEnqueueAt: this.lastEnqueueAt,
            lastFlushAt: this.lastFlushAt,
            totalBatches: this.totalBatches
        };
    }
}
