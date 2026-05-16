/**
 * 世界书管理模块
 * 兼容 SillyTavern WorldInfo 格式
 */

import fs from 'fs';
import path from 'path';
import { safeJsonParse, safeJsonParseWithFallback } from './json-utils.js';

export class WorldBookManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.worldsDir = path.join(dataDir, 'worlds');
        this.cache = new Map();
        this.currentWorldBook = null;
        this.currentWorldBookName = null;
        
        // ✅ 确保世界书目录存在
        if (!fs.existsSync(this.worldsDir)) {
            fs.mkdirSync(this.worldsDir, { recursive: true });
        }
    }


    /**
     * 读取世界书
     */
    readWorldBook(characterName) {
        // 检查缓存
        if (this.cache.has(characterName)) {
            return this.cache.get(characterName);
        }

        // 尝试多种可能的文件名格式
        const possibleNames = [
            characterName + "'s Lorebook.json",  // 弯引号
            characterName + "'s Lorebook.json",  // 直引号
            characterName + " Lorebook.json",
            characterName + ".json"
        ];

        // 先尝试直接匹配
        for (const name of possibleNames) {
            const filePath = path.join(this.worldsDir, name);
            if (fs.existsSync(filePath)) {
                const worldBook = safeJsonParse(fs.readFileSync(filePath, 'utf8'), 10 * 1024 * 1024); // 世界书限制 10MB
                this.cache.set(characterName, worldBook);
                return worldBook;
            }
        }

        // 模糊匹配：扫描目录查找包含角色名的文件
        if (fs.existsSync(this.worldsDir)) {
            const files = fs.readdirSync(this.worldsDir);
            for (const file of files) {
                if (file.includes(characterName) && file.endsWith('.json')) {
                    const filePath = path.join(this.worldsDir, file);
                    const worldBook = safeJsonParse(fs.readFileSync(filePath, 'utf8'), 10 * 1024 * 1024);
                    this.cache.set(characterName, worldBook);
                    return worldBook;
                }
            }
        }

        return null;
    }

    /**
     * 匹配世界书条目
     * @param {Object} worldBook - 世界书对象
     * @param {string} inputText - 用于匹配的文本（包括历史消息）
     * @param {number} maxEntries - 最大返回条目数
     * @param {Set<string>} stickyKeys - 当前会话中仍然粘性的条目键集合
     */
    matchEntries(worldBook, inputText, maxEntries = 10, stickyKeys = new Set()) {
        if (!worldBook || !worldBook.entries) {
            return [];
        }

        const normalizeKeys = (value) => {
            if (Array.isArray(value)) {
                return value.filter((item) => typeof item === 'string' && item.trim());
            }

            if (typeof value === 'string' && value.trim()) {
                return [value];
            }

            return [];
        };

        const isEnabled = (value, fallback = true) => {
            if (value === undefined || value === null || value === '') {
                return fallback;
            }

            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (['false', '0', 'off', 'no'].includes(normalized)) {
                    return false;
                }
                if (['true', '1', 'on', 'yes'].includes(normalized)) {
                    return true;
                }
            }

            return Boolean(value);
        };

        const normalizeNumber = (value, fallback = 0) => {
            const normalized = Number(value);
            return Number.isFinite(normalized) ? normalized : fallback;
        };

        const normalizePosition = (value) => {
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if ([
                    '1',
                    'after',
                    'after_char',
                    'after_character',
                    'after_description',
                    'post',
                    'post_history',
                    'post-history'
                ].includes(normalized)) {
                    return 1;
                }

                if ([
                    '0',
                    'before',
                    'before_char',
                    'before_character',
                    'before_description',
                    'system',
                    'pre_history',
                    'pre-history'
                ].includes(normalized)) {
                    return 0;
                }
            }

            return normalizeNumber(value, 0);
        };

        const matched = [];
        const constants = [];
        const stickyMatched = [];
        const inputLower = inputText.toLowerCase();

        const entriesArray = Array.isArray(worldBook.entries)
            ? worldBook.entries
            : Object.values(worldBook.entries);

        for (const entry of entriesArray) {
            if (!isEnabled(entry.enabled, true) || isEnabled(entry.disable, false)) {
                continue;
            }

            const keys = normalizeKeys(entry.keys ?? entry.key);
            const entryKey = entry.uid || entry.id || keys[0] || entry.comment || entry.name || 'unknown';
            const sticky = normalizeNumber(entry.sticky, 0);
            const order = normalizeNumber(entry.order ?? entry.insertion_order, 0);
            const position = normalizePosition(entry.position);

            if (isEnabled(entry.constant, false)) {
                constants.push({
                    content: entry.content,
                    order,
                    key: entryKey,
                    isConstant: true,
                    position,
                    sticky: 0
                });
                continue;
            }

            const isStickyActive = stickyKeys.has(entryKey);
            const secondaryKeys = normalizeKeys(entry.secondary_keys ?? entry.keysecondary);
            let primaryMatch = false;
            let secondaryMatch = secondaryKeys.length === 0;

            for (const key of keys) {
                if (key && inputLower.includes(key.toLowerCase())) {
                    primaryMatch = true;
                    break;
                }
            }

            if (primaryMatch && secondaryKeys.length > 0) {
                const logic = normalizeNumber(entry.selectiveLogic, 0);

                if (logic === 0) {
                    secondaryMatch = secondaryKeys.some((k) => k && inputLower.includes(k.toLowerCase()));
                } else if (logic === 1) {
                    secondaryMatch = !secondaryKeys.every((k) => k && inputLower.includes(k.toLowerCase()));
                } else if (logic === 2) {
                    secondaryMatch = !secondaryKeys.some((k) => k && inputLower.includes(k.toLowerCase()));
                } else if (logic === 3) {
                    secondaryMatch = secondaryKeys.every((k) => k && inputLower.includes(k.toLowerCase()));
                }
            }

            const keywordMatch = primaryMatch && secondaryMatch;

            if (keywordMatch || isStickyActive) {
                const entryData = {
                    content: entry.content,
                    order,
                    key: entryKey,
                    keys,
                    comment: entry.comment || entry.name || keys[0] || '未命名',
                    isConstant: false,
                    position,
                    sticky,
                    triggeredByKeyword: keywordMatch,
                    triggeredBySticky: isStickyActive && !keywordMatch
                };

                if (keywordMatch) {
                    matched.push(entryData);
                } else {
                    stickyMatched.push(entryData);
                }
            }
        }

        const all = [...constants, ...matched, ...stickyMatched];
        all.sort((a, b) => b.order - a.order);

        return all.slice(0, maxEntries);
    }

    /**
     * 获取所有世界书列表
     */
    listWorldBooks() {
        if (!fs.existsSync(this.worldsDir)) {
            return [];
        }

        const files = fs.readdirSync(this.worldsDir);
        return files.filter(f => f.endsWith('.json'));
    }

    /**
     * 清除缓存
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * 获取当前加载的世界书
     */
    getCurrentWorldBook() {
        if (!this.currentWorldBook) {
            return null;
        }
        return {
            name: this.currentWorldBookName,
            entries: this.currentWorldBook.entries ? Object.keys(this.currentWorldBook.entries).length : 0
        };
    }

    /**
     * 加载世界书
     */
    loadWorldBook(filename) {
        const filePath = path.join(this.worldsDir, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`世界书文件不存在: ${filePath}`);
        }

        const worldBook = safeJsonParse(fs.readFileSync(filePath, 'utf8'), 10 * 1024 * 1024);
        this.currentWorldBook = worldBook;
        this.currentWorldBookName = filename.replace('.json', '');
        this.cache.set(filename, worldBook);
        
        return {
            name: this.currentWorldBookName,
            entries: worldBook.entries ? Object.keys(worldBook.entries).length : 0
        };
    }

    /**
     * 扫描世界书目录（刷新列表）
     */
    scanWorldBooks() {
        this.clearCache();
        return this.listWorldBooks();
    }

    /**
     * 查找匹配的条目（用于测试）
     */
    findMatchingEntries(text) {
        if (!this.currentWorldBook) {
            return [];
        }
        return this.matchEntries(this.currentWorldBook, text);
    }
}
