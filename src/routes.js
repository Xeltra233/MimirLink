/**
 * API 路由模块
 * 提供 Web 管理面板的后端接口
 */

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { RegexProcessor } from './regex.js';
import { PromptBuilder } from './prompt.js';
import { inspectMemoryDatabase } from './session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 设置路由
 * @param {express.Application} app - Express 应用
 * @param {Object} deps - 依赖注入
 */
export function setupRoutes(app, config, saveConfig, managers) {
    const { characterManager, worldBookManager, sessionManager, regexProcessor, aiClient, promptBuilder, logger, bot, ttsManager, VOICE_TYPES, runtime, getLastRoutingSnapshot, formatSessionLabel, getLastInjectionObservation, getLastRecallSnapshot } = managers;

    const summarizePayload = (payload, maxLen = 400) => {
        try {
            const text = JSON.stringify(payload);
            if (!text) {
                return '';
            }
            return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
        } catch {
            return '[unserializable payload]';
        }
    };

    app.use('/api', (req, res, next) => {
        const startedAt = Date.now();
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        req.requestId = requestId;

        logger.info(`[API ${requestId}] ${req.method} ${req.originalUrl} <- request`, {
            authenticated: !!req.session?.authenticated,
            contentType: req.headers['content-type'] || '',
            referer: req.headers.referer || '',
            bodyPreview: summarizePayload(req.body)
        });

        res.on('finish', () => {
            logger.info(`[API ${requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
        });

        next();
    });

    const isBackendCompatibleRegexRule = (rule) => {
        if (!rule || typeof rule !== 'object') {
            return false;
        }

        const placement = rule.stage ?? rule.placement;
        if (Array.isArray(placement)) {
            return false;
        }

        if (typeof placement === 'number') {
            return false;
        }

        if (rule.markdownOnly || rule.runOnEdit || rule.substituteRegex) {
            return false;
        }

        return true;
    };

    const ensureBindingConfig = () => {
        if (!config.bindings) {
            config.bindings = { global: { memoryDbPath: null, worldbook: null, preset: null, regexRules: null }, characters: {} };
        }
        if (!config.bindings.global) {
            config.bindings.global = { memoryDbPath: null, worldbook: null, preset: null, regexRules: null };
        }
        if (!config.bindings.characters) {
            config.bindings.characters = {};
        }
    };

    const getCharacterBinding = (characterName) => {
        ensureBindingConfig();
        if (!config.bindings.characters[characterName]) {
            config.bindings.characters[characterName] = {
                memoryDbPath: null,
                worldbook: null,
                preset: null,
                regexRules: null,
                importedFromCard: {
                    worldbook: null,
                    preset: null,
                    regexRules: []
                }
            };
        }
        return config.bindings.characters[characterName];
    };

    const getBindingSummary = (characterName) => {
        ensureBindingConfig();
        const binding = getCharacterBinding(characterName);

        const resolveSource = (explicitValue, importedValue, globalValue, legacyValue) => {
            if (explicitValue) return 'character';
            if (importedValue && (Array.isArray(importedValue) ? importedValue.length > 0 : true)) return 'card';
            if (globalValue && (Array.isArray(globalValue) ? globalValue.length > 0 : true)) return 'global';
            if (legacyValue && (Array.isArray(legacyValue) ? legacyValue.length > 0 : true)) return 'legacy';
            return 'none';
        };

        return {
            memoryDbPath: {
                source: binding.memoryDbPath ? 'character' : config.bindings.global.memoryDbPath ? 'global' : 'default',
                value: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path || null
            },
            worldbook: {
                source: resolveSource(binding.worldbook, binding.importedFromCard?.worldbook, config.bindings.global.worldbook, null),
                value: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null
            },
            preset: {
                source: resolveSource(binding.preset, binding.importedFromCard?.preset, config.bindings.global.preset, config.preset),
                value: binding.preset?.name || binding.importedFromCard?.preset?.name || config.bindings.global.preset?.name || config.preset?.name || null
            },
            regexRules: {
                source: resolveSource(binding.regexRules, binding.importedFromCard?.regexRules, config.bindings.global.regexRules, config.regex?.rules),
                count: (binding.regexRules || binding.importedFromCard?.regexRules || []).length
            },
            presetRegexRules: {
                source: resolveSource(binding.preset?.regexRules, binding.importedFromCard?.preset?.regexRules, config.preset?.regexRules, null),
                count: (binding.preset?.regexRules || binding.importedFromCard?.preset?.regexRules || config.preset?.regexRules || []).length
            },
            globalRegexRules: {
                source: (config.bindings.global.regexRules || config.regex?.rules || []).length > 0 ? 'global' : 'none',
                count: (config.bindings.global.regexRules || config.regex?.rules || []).length
            }
        };
    };

    const buildCharacterMetadataPlan = (characterName) => {
        const { metadata } = characterManager.extractSillyTavernMetadata(characterName);
        const compatibleRegexScripts = (metadata?.regexScripts || []).filter(isBackendCompatibleRegexRule);
        const plan = {
            importWorldBook: !!(metadata?.hasEmbeddedWorldBook && metadata?.worldBook),
            importPreset: !!(metadata?.postHistoryInstructions || metadata?.systemPrompt || metadata?.preferredPreset?.assistantPrefill),
            importRegex: compatibleRegexScripts.length > 0
        };

        return { metadata, plan, compatibleRegexScripts };
    };

    const applyCharacterMetadata = async (characterName, options = {}) => {
        const { metadata, plan, compatibleRegexScripts } = buildCharacterMetadataPlan(characterName);
        const applied = [];

        const finalOptions = {
            importWorldBook: options.importWorldBook ?? plan.importWorldBook,
            importPreset: options.importPreset ?? plan.importPreset,
            importRegex: options.importRegex ?? plan.importRegex
        };

        if (finalOptions.importWorldBook && metadata.hasEmbeddedWorldBook && metadata.worldBook) {
            const worldbookFilename = `${metadata.name}'s Lorebook.json`;
            const worldbookPath = path.join(config.chat.dataDir || './data', 'worlds', worldbookFilename);
            const worldbook = {
                name: `${metadata.name} 世界书`,
                description: `从角色卡 ${metadata.name} 自动提取的世界书`,
                entries: metadata.worldBook.entries || []
            };

            await fs.writeFile(worldbookPath, JSON.stringify(worldbook, null, 2), 'utf-8');
            await worldBookManager.scanWorldBooks();
            const binding = getCharacterBinding(characterName);
            binding.importedFromCard.worldbook = worldbookFilename;
            applied.push(`已自动加载内嵌世界书 (${metadata.worldBookEntries} 条)`);
        }

        if (finalOptions.importPreset && (metadata.postHistoryInstructions || metadata.systemPrompt || metadata.preferredPreset.assistantPrefill)) {
            const binding = getCharacterBinding(characterName);
            binding.importedFromCard.preset = {
                enabled: true,
                name: metadata.preferredPreset.name,
                systemPrompt: metadata.preferredPreset.systemPrompt,
                postHistoryInstructions: metadata.preferredPreset.postHistoryInstructions,
                assistantPrefill: metadata.preferredPreset.assistantPrefill,
                jailbreak: binding.preset?.jailbreak || config.preset?.jailbreak || '',
                regexRules: []
            };
            applied.push('已自动同步角色卡中的预设相关字段');
        }

        if (finalOptions.importRegex && compatibleRegexScripts.length > 0) {
            const importedRules = RegexProcessor.importRules({ rules: compatibleRegexScripts });
            if (!Array.isArray(config.regex.rules)) {
                config.regex.rules = [];
            }

            const existingKeys = new Set(config.regex.rules.map((rule) => `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`));
            const nextRules = importedRules.filter((rule) => {
                const key = `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`;
                if (existingKeys.has(key)) {
                    return false;
                }
                existingKeys.add(key);
                return true;
            });

            if (nextRules.length > 0) {
                const binding = getCharacterBinding(characterName);
                binding.importedFromCard.regexRules = nextRules;
                applied.push(`已自动导入 ${nextRules.length} 条角色卡附带正则`);
            }
        }

        saveConfig(config);
        return metadata ? { metadata, applied, plan, options: finalOptions } : { metadata: null, applied, plan, options: finalOptions };
    };

    const summarizeCharacterMetadata = (metadata) => ({
        hasEmbeddedWorldBook: !!metadata?.hasEmbeddedWorldBook,
        worldBookEntries: metadata?.worldBookEntries || 0,
        regexScriptCount: Array.isArray(metadata?.regexScripts) ? metadata.regexScripts.length : 0,
        importableRegexScriptCount: Array.isArray(metadata?.regexScripts)
            ? metadata.regexScripts.filter(isBackendCompatibleRegexRule).length
            : 0,
        alternateGreetingsCount: Array.isArray(metadata?.alternateGreetings) ? metadata.alternateGreetings.length : 0,
        hasPostHistoryInstructions: !!metadata?.postHistoryInstructions,
        hasSystemPrompt: !!metadata?.systemPrompt,
        tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
        creatorNotes: metadata?.creatorNotes || '',
        spec: metadata?.spec || '',
        specVersion: metadata?.specVersion || ''
    });

    const getActiveMemoryInfo = () => {
        const currentCharacterName = config.chat.defaultCharacter || null;
        const binding = currentCharacterName ? getBindingSummary(currentCharacterName) : null;
        return {
            currentCharacter: currentCharacterName,
            dbPath: sessionManager.getDbPath(),
            sessionMode: config.chat?.sessionMode || 'user_persistent',
            accessControlMode: config.chat?.accessControlMode || 'allowlist',
            adminUsers: config.chat?.adminUsers || [],
            scopeDescription: {
                user_persistent: '同一 QQ 跨群/跨私聊共享长期记忆',
                group_user: '每个群内每个用户单独记忆',
                group_shared: '同一群共享一份记忆',
                global_shared: '所有来源共享一份记忆'
            }[config.chat?.sessionMode || 'user_persistent'],
            binding
        };
    };

    const listKnownMemoryDatabases = async () => {
        const dataDir = config.chat.dataDir || './data';
        const baseDir = path.join(dataDir, 'chats');
        await fs.mkdir(baseDir, { recursive: true });

        const files = new Map();
        const rememberFile = async (fullPath) => {
            const normalizedPath = path.isAbsolute(fullPath) ? fullPath : path.resolve(process.cwd(), fullPath);
            if (files.has(normalizedPath)) {
                return files.get(normalizedPath);
            }

            try {
                const stat = await fs.stat(normalizedPath);
                const item = { path: normalizedPath, sizeBytes: stat.size, updatedAt: stat.mtimeMs, bindings: [] };
                files.set(normalizedPath, item);
                return item;
            } catch {
                const item = { path: normalizedPath, sizeBytes: 0, updatedAt: 0, bindings: [], missing: true };
                files.set(normalizedPath, item);
                return item;
            }
        };

        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                    continue;
                }
                if (entry.name.endsWith('.sqlite')) {
                    await rememberFile(fullPath);
                }
            }
        };

        await walk(baseDir);

        const bindDb = async (dbPath, bindingInfo) => {
            if (!dbPath) {
                return;
            }
            const item = await rememberFile(dbPath);
            item.bindings.push(bindingInfo);
        };

        await bindDb(config.bindings?.global?.memoryDbPath || config.memory?.storage?.path, { type: 'global-default', name: '全局默认记忆库' });
        for (const [characterName, binding] of Object.entries(config.bindings?.characters || {})) {
            if (binding?.memoryDbPath) {
                await bindDb(binding.memoryDbPath, { type: 'character', name: characterName });
            }
        }

        return Array.from(files.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    };

    const applyRuntimeConfig = () => {
        aiClient.updateConfig(config.ai || {});
        sessionManager.setConfig(config);
        regexProcessor.updateConfig(config.regex || {});
        promptBuilder.updateConfig(config);
        runtime?.updateConfig(config);
    };

    const mergeConfig = (target, source) => {
        for (const [key, value] of Object.entries(source || {})) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                target[key] = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
                    ? target[key]
                    : {};
                mergeConfig(target[key], value);
            } else {
                target[key] = value;
            }
        }
    };

    const normalizeAccessControlConfig = () => {
        config.chat = config.chat || {};
        const mode = config.chat.accessControlMode || 'allowlist';

        if (mode === 'blocklist') {
            config.chat.allowedGroups = [];
            config.chat.allowedUsers = [];
        }

        if (mode === 'allowlist') {
            config.chat.blockedGroups = [];
            config.chat.blockedUsers = [];
        }

        if (mode === 'disabled') {
            config.chat.allowedGroups = [];
            config.chat.allowedUsers = [];
            config.chat.blockedGroups = [];
            config.chat.blockedUsers = [];
        }
    };

    // ==================== 认证中间件 ====================
    
    // 检查是否需要认证
    const requireAuth = (req, res, next) => {
        // 如果认证未启用，直接通过
        if (!config.auth?.enabled) {
            logger.debug(`[API ${req.requestId || 'no-id'}] auth bypassed (disabled)`);
            return next();
        }
        
        // 检查是否已登录
        if (req.session?.authenticated) {
            logger.debug(`[API ${req.requestId || 'no-id'}] auth passed`, { username: req.session?.username || null });
            return next();
        }
        
        // 未登录，返回 401
        logger.warn(`[API ${req.requestId || 'no-id'}] auth failed`, {
            originalUrl: req.originalUrl,
            referer: req.headers.referer || '',
            cookiesPresent: !!req.headers.cookie
        });
        res.status(401).json({ error: '未登录', needLogin: true });
    };

    // ==================== 登录相关路由 ====================

    // 检查登录状态
    app.get('/api/auth/status', (req, res) => {
        if (!config.auth?.enabled) {
            return res.json({ enabled: false, authenticated: true });
        }
        res.json({ 
            enabled: true, 
            authenticated: req.session?.authenticated || false,
            username: req.session?.username || null,
            expiresAt: req.session?.cookie?.expires || null
        });
    });

    // 登录
    app.post('/api/auth/login', (req, res) => {
        if (!config.auth?.enabled) {
            return res.json({ success: true, message: '认证未启用' });
        }
        
        const { username, password, rememberMe } = req.body;
        
        if (username === config.auth.username && password === config.auth.password) {
            req.session.authenticated = true;
            req.session.username = username;
            const longDays = config.auth.sessionDays ?? 30;
            const shortHours = config.auth.shortSessionHours ?? 12;
            req.session.cookie.maxAge = rememberMe
                ? longDays * 24 * 60 * 60 * 1000
                : shortHours * 60 * 60 * 1000;
            logger.info(`用户 ${username} 登录成功`);
            res.json({ success: true, message: '登录成功', expiresInMs: req.session.cookie.maxAge });
        } else {
            logger.warn(`登录失败: 用户名或密码错误`);
            res.status(401).json({ success: false, error: '用户名或密码错误' });
        }
    });

    // 登出
    app.post('/api/auth/logout', (req, res) => {
        if (req.session) {
            req.session.destroy();
        }
        res.json({ success: true, message: '已登出' });
    });

    // 文件上传配置
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const isCharacter = req.path.includes('/characters/');
            const isWorldbook = req.path.includes('/worldbooks/');
            let destDir;
            if (isCharacter) {
                destDir = path.join(config.chat.dataDir || './data', 'characters');
            } else if (isWorldbook) {
                destDir = path.join(config.chat.dataDir || './data', 'worlds');
            } else {
                destDir = config.chat.dataDir || './data';
            }
            // 确保目录存在
            fs.mkdir(destDir, { recursive: true }).then(() => cb(null, destDir)).catch(err => cb(err));
        },
        filename: (req, file, cb) => {
            // 保持原文件名，处理中文编码
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, originalName);
        }
    });
    
    const upload = multer({ 
        storage,
        fileFilter: (req, file, cb) => {
            const isCharacter = req.path.includes('/characters/');
            const isWorldbook = req.path.includes('/worldbooks/');
            if (isCharacter && !file.originalname.toLowerCase().endsWith('.png')) {
                cb(new Error('角色卡必须是 PNG 格式'));
            } else if (isWorldbook && !file.originalname.toLowerCase().endsWith('.json')) {
                cb(new Error('世界书必须是 JSON 格式'));
            } else {
                cb(null, true);
            }
        },
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB 限制
    });

    // ==================== 配置管理 ====================

    // 获取配置（需要认证）
    app.get('/api/config', requireAuth, (req, res) => {
        // 隐藏敏感信息
        const safeConfig = {
            ...config,
            ai: {
                ...config.ai,
                apiKey: config.ai.apiKey ? '******' : ''
            }
        };
        res.json(safeConfig);
    });

    // 更新配置（需要认证）
	app.post('/api/config', requireAuth, async (req, res) => {
		try {
			const newConfig = req.body;

			if (newConfig?.ai?.apiKey === '******') {
				delete newConfig.ai.apiKey;
			}

			mergeConfig(config, newConfig);
			normalizeAccessControlConfig();
			applyRuntimeConfig();
			saveConfig(config);
			
			logger.info('配置已更新');
			res.json({ success: true, message: '配置已保存并立即生效（无需重启）' });
		} catch (error) {
			logger.error('保存配置失败', error);
			res.status(500).json({ success: false, error: error.message });
		}
	});

    // ==================== 角色卡管理 ====================

    // 获取角色列表（需要认证）
    app.get('/api/characters', requireAuth, async (req, res) => {
        try {
            const filenames = characterManager.listCharacters();
            // 返回包含 name 和 filename 的对象数组
            const characters = filenames.map(filename => {
                try {
                    const char = characterManager.readFromPng(filename);
                    return {
                        name: char.name || filename,
                        filename: filename + '.png'
                    };
                } catch (e) {
                    return {
                        name: filename,
                        filename: filename + '.png'
                    };
                }
            });
            res.json(characters);
        } catch (error) {
            logger.error('获取角色列表失败', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 获取当前角色（需要认证）
    app.get('/api/characters/current', requireAuth, (req, res) => {
        const character = characterManager.getCurrentCharacter();
        if (character) {
            res.json(character);
        } else {
            res.status(404).json({ error: '未选择角色' });
        }
    });

    // 选择角色（需要认证）
    app.post('/api/characters/select', requireAuth, async (req, res) => {
        try {
            const { filename, importOptions, memoryBinding } = req.body;
            // 移除 .png 扩展名
            const characterName = filename.replace(/\.png$/i, '');
            const character = characterManager.loadCharacter(characterName);
            const characterMeta = await applyCharacterMetadata(characterName, importOptions || {});

            if (memoryBinding?.mode) {
                const binding = getCharacterBinding(characterName);
                if (memoryBinding.mode === 'inherit') {
                    binding.memoryDbPath = null;
                } else if (memoryBinding.mode === 'character') {
                    const normalizedName = characterName.replace(/[\\/:*?"<>|]/g, '_');
                    binding.memoryDbPath = memoryBinding.dbPath || `./data/chats/characters/${normalizedName}.sqlite`;
                } else if (memoryBinding.mode === 'custom' && memoryBinding.dbPath) {
                    binding.memoryDbPath = memoryBinding.dbPath;
                }

                if (memoryBinding.migrateFromCurrent === true && binding.memoryDbPath) {
                    const snapshot = sessionManager.exportMemory();
                    const TargetManagerClass = sessionManager.constructor;
                    const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    targetManager.setConfig(config, { storagePath: binding.memoryDbPath });
                    targetManager.importMemorySnapshot(snapshot, { replace: true });
                }
            }
            
            // 更新配置并保存，确保重启后仍然使用选择的角色
            config.chat.defaultCharacter = characterName;
            if (memoryBinding?.mode) {
                const binding = getCharacterBinding(characterName);
                sessionManager.setConfig(config, { storagePath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }
            saveConfig(config);
            
            logger.info(`已选择角色: ${characterName}`);
            res.json({
                success: true,
                character,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                appliedActions: characterMeta.applied,
                importPlan: characterMeta.plan,
                importOptions: characterMeta.options,
                bindingSummary: getBindingSummary(characterName)
            });
        } catch (error) {
            logger.error('选择角色失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新角色列表（需要认证）
    app.post('/api/characters/refresh', requireAuth, async (req, res) => {
        try {
            await characterManager.scanCharacters();
            const characters = await characterManager.listCharacters();
            res.json({ success: true, characters });
        } catch (error) {
            logger.error('刷新角色列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 上传角色卡（需要认证）
    app.post('/api/characters/upload', requireAuth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: '未上传文件' });
            }
            logger.info(`角色卡已上传: ${req.file.filename}`);
            // 刷新角色列表
            await characterManager.scanCharacters();
            const characters = await characterManager.listCharacters();
            const characterName = req.file.filename.replace(/\.png$/i, '');
            const characterMeta = characterManager.extractSillyTavernMetadata(characterName);
            const plan = buildCharacterMetadataPlan(characterName);
            res.json({
                success: true,
                message: '角色卡上传成功',
                filename: req.file.filename,
                characters,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                importPlan: plan.plan,
                bindingSummary: getBindingSummary(characterName)
            });
        } catch (error) {
            logger.error('上传角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除角色卡（需要认证）
    app.delete('/api/characters/:filename', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { deleteMemoryDb, migrateMemoryToDefault } = req.body || {};
            const characterName = filename.replace(/\.png$/i, '');
            const binding = getCharacterBinding(characterName);
            const boundDbPath = binding.memoryDbPath;

            if (migrateMemoryToDefault === true && boundDbPath) {
                const TargetManagerClass = sessionManager.constructor;
                const sourceManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                sourceManager.setConfig(config, { storagePath: boundDbPath });
                const snapshot = sourceManager.exportMemory();
                const defaultPath = config.bindings.global.memoryDbPath || config.memory?.storage?.path;
                const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                targetManager.setConfig(config, { storagePath: defaultPath });
                targetManager.importMemorySnapshot(snapshot, { replace: false });
            }

            const filePath = path.join(config.chat.dataDir || './data', 'characters', filename);
            await fs.unlink(filePath);

            if (deleteMemoryDb === true && boundDbPath) {
                try {
                    await fs.unlink(path.isAbsolute(boundDbPath) ? boundDbPath : path.resolve(process.cwd(), boundDbPath));
                } catch {
                    // ignore missing db file
                }
            }

            delete config.bindings?.characters?.[characterName];
            if (config.chat.defaultCharacter === characterName) {
                config.chat.defaultCharacter = '';
                sessionManager.setConfig(config, { storagePath: config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }
            saveConfig(config);
            await characterManager.scanCharacters();
            logger.info(`角色卡已删除: ${filename}`);
            res.json({ success: true, message: '角色卡已删除' });
        } catch (error) {
            logger.error('删除角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取角色卡详情（需要认证）
    app.get('/api/characters/:filename/detail', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const characterName = filename.replace(/\.png$/i, '');
            const character = characterManager.readFromPng(characterName);
            const characterMeta = characterManager.extractSillyTavernMetadata(characterName);
            res.json({
                success: true,
                character,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                importPlan: buildCharacterMetadataPlan(characterName).plan,
                bindingSummary: getBindingSummary(characterName)
            });
        } catch (error) {
            logger.error('获取角色卡详情失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新角色卡（保存编辑，需要认证）
    app.post('/api/characters/:filename/update', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const updates = req.body;
            
            // 更新角色卡数据
            const characterName = filename.replace(/\.png$/i, '');
            const updated = characterManager.updateCharacter(characterName, updates);
            
            logger.info(`角色卡已更新: ${filename}`);
            res.json({ success: true, message: '角色卡已保存', character: updated });
        } catch (error) {
            logger.error('更新角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 世界书管理 ====================

    // 获取世界书列表（需要认证）
    app.get('/api/worldbooks', requireAuth, async (req, res) => {
        try {
            const worldbooks = await worldBookManager.listWorldBooks();
            // 过滤掉无效的文件名
            const validWorldbooks = worldbooks.filter(f => f && f !== 'undefined' && f.endsWith('.json'));
            res.json(validWorldbooks);
        } catch (error) {
            logger.error('获取世界书列表失败', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 获取当前世界书（需要认证）
    app.get('/api/worldbooks/current', requireAuth, (req, res) => {
        const worldbook = worldBookManager.getCurrentWorldBook();
        if (worldbook) {
            res.json(worldbook);
        } else {
            res.status(404).json({ error: '未加载世界书' });
        }
    });

    // 选择世界书（需要认证）
    app.post('/api/worldbooks/select', requireAuth, async (req, res) => {
        try {
            const { filename } = req.body;
            const worldbook = await worldBookManager.loadWorldBook(filename);
            res.json({ success: true, worldbook });
        } catch (error) {
            logger.error('选择世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新世界书列表（需要认证）
    app.post('/api/worldbooks/refresh', requireAuth, async (req, res) => {
        try {
            await worldBookManager.scanWorldBooks();
            const worldbooks = await worldBookManager.listWorldBooks();
            res.json({ success: true, worldbooks });
        } catch (error) {
            logger.error('刷新世界书列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 上传世界书（需要认证）
    app.post('/api/worldbooks/upload', requireAuth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: '未上传文件' });
            }
            logger.info(`世界书已上传: ${req.file.filename}`);
            // 刷新世界书列表
            await worldBookManager.scanWorldBooks();
            const worldbooks = await worldBookManager.listWorldBooks();
            res.json({ success: true, message: '世界书上传成功', filename: req.file.filename, worldbooks });
        } catch (error) {
            logger.error('上传世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除世界书（需要认证）
    app.delete('/api/worldbooks/:filename', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            await fs.unlink(filePath);
            await worldBookManager.scanWorldBooks();
            logger.info(`世界书已删除: ${filename}`);
            res.json({ success: true, message: '世界书已删除' });
        } catch (error) {
            logger.error('删除世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试世界书匹配（需要认证）
    app.post('/api/worldbooks/test', requireAuth, (req, res) => {
        try {
            const { text } = req.body;
            const entries = worldBookManager.findMatchingEntries(text);
            res.json({ success: true, entries });
        } catch (error) {
            logger.error('测试世界书匹配失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取世界书内容（用于编辑，需要认证）
    app.get('/api/worldbooks/:filename/content', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            const content = await fs.readFile(filePath, 'utf-8');
            const worldbook = JSON.parse(content);
            res.json({ success: true, worldbook });
        } catch (error) {
            logger.error('获取世界书内容失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 保存世界书内容（需要认证）
    app.post('/api/worldbooks/:filename/save', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { worldbook } = req.body;
            
            if (!worldbook) {
                return res.status(400).json({ success: false, error: '请提供世界书数据' });
            }
            
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            await fs.writeFile(filePath, JSON.stringify(worldbook, null, 2), 'utf-8');
            
            // 清除缓存，强制重新加载
            worldBookManager.clearCache();
            
            // 如果当前加载的是这个世界书，重新加载
            const currentWorldBook = worldBookManager.getCurrentWorldBook();
            const currentFilename = currentWorldBook ? currentWorldBook.name + '.json' : null;
            if (currentFilename === filename) {
                await worldBookManager.loadWorldBook(filename);
            }
            
            logger.info(`世界书已保存: ${filename}`);
            res.json({ success: true, message: '世界书已保存' });
        } catch (error) {
            logger.error('保存世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 从角色卡提取内嵌世界书（需要认证）
    app.post('/api/worldbooks/extract-from-character', requireAuth, async (req, res) => {
        try {
            const { filename } = req.body;
            
            // 验证 filename
            if (!filename || typeof filename !== 'string') {
                return res.status(400).json({ success: false, error: '请提供有效的角色卡文件名' });
            }
            
            const characterName = filename.replace(/\.png$/i, '');
            
            // 读取角色卡
            const character = characterManager.readFromPng(characterName);
            
            // 查找内嵌世界书（可能在顶层或 data 对象内）
            const characterBook = character.character_book || character.data?.character_book;
            
            if (!characterBook) {
                return res.status(404).json({ success: false, error: '该角色卡没有内嵌世界书' });
            }
            
            // 获取角色名称（可能在顶层或 data 对象内）
            const charName = character.name || character.data?.name || characterName;
            
            // 生成世界书文件名（使用 Lorebook 格式）
            const worldbookFilename = `${charName}'s Lorebook.json`;
            const worldbookPath = path.join(config.chat.dataDir || './data', 'worlds', worldbookFilename);
            
            // 转换为标准世界书格式
            const worldbook = {
                name: `${charName} 世界书`,
                description: `从角色卡 ${charName} 提取的世界书`,
                entries: characterBook.entries || []
            };
            
            // 保存世界书文件
            await fs.writeFile(worldbookPath, JSON.stringify(worldbook, null, 2), 'utf-8');
            
            // 刷新世界书列表
            await worldBookManager.scanWorldBooks();
            
            logger.info(`已从角色卡提取世界书: ${worldbookFilename}`);
            res.json({ 
                success: true, 
                message: '世界书已提取并保存', 
                filename: worldbookFilename,
                entriesCount: worldbook.entries.length
            });
        } catch (error) {
			logger.error('提取世界书失败', error);  // ✅ 只保留一行
			res.status(500).json({ success: false, error: error.message });
		}

    });

    // ==================== 会话管理 ====================

    // 获取所有会话（需要认证）
    app.get('/api/sessions', requireAuth, (req, res) => {
        const sessions = sessionManager.listSessions().map((session) => ({
            ...session,
            label: typeof formatSessionLabel === 'function' ? formatSessionLabel(session.id) : session.id
        }));
        res.json(sessions);
    });

    // 获取指定会话（需要认证）
    app.get('/api/sessions/:sessionId', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        const session = sessionManager.getSession(sessionId);
        if (session) {
            res.json(session);
        } else {
            res.status(404).json({ error: '会话不存在' });
        }
    });

    // 获取会话历史（需要认证）
    app.get('/api/sessions/:sessionId/history', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const history = sessionManager.getHistory(sessionId, limit);
        res.json(history);
    });

    // 清除会话历史（需要认证）
    app.delete('/api/sessions/:sessionId/history', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        sessionManager.clearHistory(sessionId);
        res.json({ success: true, message: '会话历史已清除' });
    });

    // 删除会话（需要认证）
    app.delete('/api/sessions/:sessionId', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        sessionManager.deleteSession(sessionId);
        res.json({ success: true, message: '会话已删除' });
    });

    // ==================== 全局记忆管理 ====================

    // 获取全局记忆统计（需要认证）
    app.get('/api/memory/stats', requireAuth, (req, res) => {
        const stats = {
            ...sessionManager.getStats(),
            runtime: runtime?.getStats?.() || null,
            activeMemory: getActiveMemoryInfo()
        };
        res.json(stats);
    });

    app.post('/api/memory/migrate', requireAuth, (req, res) => {
        try {
            const { targetPath, sourcePath, replace, sessionIds, sessionPrefix, userId } = req.body || {};
            if (!targetPath) {
                return res.status(400).json({ success: false, error: '目标数据库路径不能为空' });
            }

            const SourceManagerClass = sessionManager.constructor;
            const sourceManager = sourcePath
                ? new SourceManagerClass(config.chat.dataDir || './data', config, logger)
                : sessionManager;

            if (sourcePath) {
                sourceManager.setConfig(config, { storagePath: sourcePath });
            }

            const snapshot = (sessionIds?.length || sessionPrefix || userId)
                ? sourceManager.exportMemoryByFilter({ sessionIds, sessionPrefix, userId })
                : sourceManager.exportMemory();
            const targetManager = new SourceManagerClass(config.chat.dataDir || './data', config, logger);
            targetManager.setConfig(config, { storagePath: targetPath });
            const result = targetManager.importMemorySnapshot(snapshot, { replace });

            res.json({
                success: true,
                result,
                sourcePath: sourceManager.getDbPath(),
                targetPath: targetManager.getDbPath(),
                message: '记忆迁移完成'
            });
        } catch (error) {
            logger.error('迁移记忆失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/memory/databases', requireAuth, async (req, res) => {
        try {
            const databases = await listKnownMemoryDatabases();
            const enriched = databases.map((db) => ({
                ...db,
                stats: inspectMemoryDatabase(db.path)
            }));
            res.json({ success: true, databases: enriched, active: getActiveMemoryInfo() });
        } catch (error) {
            logger.error('获取数据库列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/characters/:filename/memory-binding', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { mode, dbPath, migrateToDefault } = req.body || {};
            const characterName = filename.replace(/\.png$/i, '');
            const binding = getCharacterBinding(characterName);
            const currentBindingPath = binding.memoryDbPath;

            if (mode === 'inherit') {
                if (migrateToDefault === true && currentBindingPath) {
                    const TargetManagerClass = sessionManager.constructor;
                    const sourceManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    sourceManager.setConfig(config, { storagePath: currentBindingPath });
                    const snapshot = sourceManager.exportMemory();
                    const defaultPath = config.bindings.global.memoryDbPath || config.memory?.storage?.path;
                    const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    targetManager.setConfig(config, { storagePath: defaultPath });
                    targetManager.importMemorySnapshot(snapshot, { replace: false });
                }
                binding.memoryDbPath = null;
            } else if (mode === 'character') {
                const normalizedName = characterName.replace(/[\\/:*?"<>|]/g, '_');
                binding.memoryDbPath = dbPath || `./data/chats/characters/${normalizedName}.sqlite`;
            } else if (mode === 'custom') {
                if (!dbPath) {
                    return res.status(400).json({ success: false, error: '自定义数据库路径不能为空' });
                }
                binding.memoryDbPath = dbPath;
            } else {
                return res.status(400).json({ success: false, error: '未知的绑定模式' });
            }

            if (config.chat.defaultCharacter === characterName) {
                sessionManager.setConfig(config, { storagePath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }

            saveConfig(config);
            res.json({
                success: true,
                bindingSummary: getBindingSummary(characterName),
                message: mode === 'inherit' ? '角色数据库绑定已解绑，已回退到全局默认库' : '角色数据库绑定已更新'
            });
        } catch (error) {
            logger.error('更新角色数据库绑定失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取全局记忆（需要认证）
    app.get('/api/memory/global', requireAuth, (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        const includeMetadata = req.query.metadata === 'true';
        const messages = sessionManager.getGlobalHistory(limit, includeMetadata);
        res.json({ messages, stats: sessionManager.getStats() });
    });

    // 搜索全局记忆（需要认证）
    app.post('/api/memory/search', requireAuth, (req, res) => {
        const { keyword, limit } = req.body;
        const results = sessionManager.searchMessages(keyword, limit || 50);
        res.json({ results, count: results.length });
    });

    // 清空全局记忆（需要认证，危险操作）
    app.post('/api/memory/clear-all', requireAuth, (req, res) => {
        const { confirm } = req.body;
        if (confirm === 'CLEAR_ALL_MEMORY') {
            sessionManager.clearGlobalMemory();
            logger.warn('全局记忆已被清空');
            res.json({ success: true, message: '全局记忆已清空' });
        } else {
            res.status(400).json({ success: false, error: '请提供确认码: CLEAR_ALL_MEMORY' });
        }
    });

    // 导出全局记忆（需要认证）
    app.get('/api/memory/export', requireAuth, (req, res) => {
        const data = sessionManager.exportMemory();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=memory-export-${Date.now()}.json`);
        res.send(JSON.stringify(data, null, 2));
    });

    // ==================== 正则规则管理 ====================

    // 获取正则规则（需要认证）
    app.get('/api/regex', requireAuth, (req, res) => {
        const rules = regexProcessor.getRules();
        res.json(rules);
    });

    // 添加正则规则（需要认证）
    app.post('/api/regex', requireAuth, (req, res) => {
        try {
            const rule = req.body;
            if (!Array.isArray(config.regex.rules)) {
                config.regex.rules = [];
            }
            config.regex.rules.push(rule);
            regexProcessor.updateConfig(config.regex);
            saveConfig(config);
            res.json({ success: true, message: '规则已添加' });
        } catch (error) {
            logger.error('添加正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除正则规则（需要认证）
    app.delete('/api/regex/:index', requireAuth, (req, res) => {
        const index = parseInt(req.params.index);
        if (!Array.isArray(config.regex.rules)) {
            config.regex.rules = [];
        }
        if (index >= 0 && index < config.regex.rules.length) {
            config.regex.rules.splice(index, 1);
        }
        regexProcessor.updateConfig(config.regex);
        saveConfig(config);
        res.json({ success: true, message: '规则已删除' });
    });

    // 更新正则规则（需要认证）
    app.put('/api/regex/:index', requireAuth, (req, res) => {
        try {
            const index = parseInt(req.params.index);
            if (!Array.isArray(config.regex.rules)) {
                config.regex.rules = [];
            }
            if (index < 0 || index >= config.regex.rules.length) {
                return res.status(404).json({ success: false, error: '规则不存在' });
            }

            config.regex.rules[index] = {
                ...config.regex.rules[index],
                ...req.body
            };
            regexProcessor.updateConfig(config.regex);
            saveConfig(config);
            res.json({ success: true, message: '规则已更新' });
        } catch (error) {
            logger.error('更新正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试正则规则（需要认证）
    app.post('/api/regex/test', requireAuth, (req, res) => {
        try {
            const { pattern, flags, replacement, testText } = req.body;
            const result = regexProcessor.testRule(pattern, flags, replacement, testText);
            res.json(result);
        } catch (error) {
            logger.error('测试正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 测试功能 ====================

    // 测试 AI 调用（需要认证）
    app.post('/api/test/ai', requireAuth, async (req, res) => {
        try {
            const { message } = req.body;
            const response = await aiClient.chat([
                { role: 'user', content: message }
            ]);
            res.json({ success: true, response });
        } catch (error) {
            logger.error('测试 AI 调用失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/ai/models', requireAuth, async (req, res) => {
        try {
            const { baseUrl, apiKey } = req.body || {};
            const models = await aiClient.listModels({
                baseUrl: baseUrl || config.ai?.baseUrl,
                apiKey: apiKey || config.ai?.apiKey
            });
            res.json({ success: true, models });
        } catch (error) {
            logger.error('拉取模型列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/ai/probe', requireAuth, async (req, res) => {
        try {
            const { baseUrl, apiKey, model } = req.body || {};
            const result = await aiClient.probeModel(model, {
                baseUrl: baseUrl || config.ai?.baseUrl,
                apiKey: apiKey || config.ai?.apiKey
            });
            res.json({
                success: true,
                model: result.model,
                availableModels: result.availableModels,
                autoMaxTokens: result.model?.recommendedMaxTokens || result.model?.maxOutputTokens || null
            });
        } catch (error) {
            logger.error('探测模型元数据失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 日志 ====================

    // 获取最近日志（需要认证）
    app.get('/api/logs', requireAuth, (req, res) => {
        const logs = logger.getRecentLogs();
        res.json(logs);
    });

    // ==================== TTS 语音合成 ====================

    // 获取 TTS 配置（需要认证）
    app.get('/api/tts/config', requireAuth, (req, res) => {
        const ttsConfig = ttsManager.getConfig();
        // 隐藏 token
        res.json({
            ...ttsConfig,
            token: ttsConfig.token ? '******' : ''
        });
    });

    // 更新 TTS 配置（需要认证）
    app.post('/api/tts/config', requireAuth, (req, res) => {
        try {
            const newConfig = req.body;
            console.log('[TTS] 收到配置:', JSON.stringify(newConfig, null, 2));
            // 字段名映射：前端 -> 后端
            const mappedConfig = {
                enabled: newConfig.enabled,
                appid: newConfig.appId || newConfig.appid,
                token: newConfig.accessToken || newConfig.token,
                voiceType: newConfig.voiceType,
                speedRatio: newConfig.speed || newConfig.speedRatio || 1.0,
                volumeRatio: newConfig.volume || newConfig.volumeRatio || 1.0,
                pitchRatio: newConfig.pitch || newConfig.pitchRatio || 1.0
            };
            console.log('[TTS] 映射后配置:', JSON.stringify(mappedConfig, null, 2));
            ttsManager.updateConfig(mappedConfig);
            logger.info('TTS 配置已更新');
            res.json({ success: true, message: 'TTS 配置已保存' });
        } catch (error) {
            logger.error('更新 TTS 配置失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取可用音色列表（需要认证）
    app.get('/api/tts/voices', requireAuth, (req, res) => {
        // 将对象格式转换为数组格式 [{id, name}]
        const voiceList = Object.entries(VOICE_TYPES).map(([id, name]) => ({
            id,
            name
        }));
        res.json(voiceList);
    });

    // 测试 TTS 合成（需要认证）
    app.post('/api/tts/test', requireAuth, async (req, res) => {
        try {
            const { text } = req.body;
            if (!text) {
                return res.status(400).json({ success: false, error: '请提供测试文本' });
            }
            
            const audioPath = await ttsManager.synthesize(text);
            // 提取文件名，生成可访问的 URL
            const filename = path.basename(audioPath);
            const audioUrl = `/audio/${filename}`;
            
            logger.info(`TTS 测试成功: ${audioPath}`);
            res.json({ 
                success: true, 
                audioUrl,
                filePath: audioPath,
                message: '语音合成成功' 
            });
        } catch (error) {
            logger.error('TTS 测试失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 系统信息 ====================

    // 获取系统状态（需要认证）
    app.get('/api/status', requireAuth, (req, res) => {
        res.json({
            version: '1.0.0',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            onebot: {
                connected: bot ? bot.isConnected() : false
            },
            character: characterManager.getCurrentCharacter()?.name || '未选择',
            characterFile: config.chat?.defaultCharacter ? `${config.chat.defaultCharacter}.png` : null,
            worldbook: worldBookManager.getCurrentWorldBook()?.name || '未加载',
            sessions: sessionManager.listSessions().length,
            globalMemory: sessionManager.getStats(),
            runtime: runtime?.getStats?.() || null,
            activeMemory: getActiveMemoryInfo(),
            lastRouting: typeof getLastRoutingSnapshot === 'function' ? getLastRoutingSnapshot() : null,
            lastInjectionObservation: typeof getLastInjectionObservation === 'function' ? getLastInjectionObservation() : null,
            lastRecall: typeof getLastRecallSnapshot === 'function' ? getLastRecallSnapshot() : null,
            server: {
                host: config.server?.host,
                port: config.server?.port,
                healthLogIntervalMs: config.server?.healthLogIntervalMs ?? 60000
            }
        });
    });

    app.post('/api/regex/import', requireAuth, (req, res) => {
        try {
            logger.info(`[API ${req.requestId || 'no-id'}] regex import started`, {
                bodyPreview: summarizePayload(req.body, 1200)
            });
            const importedRules = RegexProcessor.importRules(req.body);
            const diagnostics = RegexProcessor.diagnoseImport(req.body);
            const targetLayer = req.body?.targetLayer || 'global';
            logger.info(`[API ${req.requestId || 'no-id'}] regex import diagnostics`, diagnostics);
            if (importedRules.length === 0) {
                logger.warn(`[API ${req.requestId || 'no-id'}] regex import produced zero compatible rules`);
                return res.status(400).json({ success: false, error: '未识别到可导入的正则规则' });
            }

            let targetRules = null;
            if (targetLayer === 'preset') {
                config.preset = { ...(config.preset || {}), regexRules: Array.isArray(config.preset?.regexRules) ? config.preset.regexRules : [] };
                targetRules = config.preset.regexRules;
            } else if (targetLayer === 'character') {
                const currentCharacterName = config.chat?.defaultCharacter;
                if (!currentCharacterName) {
                    return res.status(400).json({ success: false, error: '当前没有选中角色，无法导入到角色层' });
                }
                const binding = getCharacterBinding(currentCharacterName);
                binding.regexRules = Array.isArray(binding.regexRules) ? binding.regexRules : [];
                targetRules = binding.regexRules;
            } else {
                config.bindings.global.regexRules = Array.isArray(config.bindings.global.regexRules) ? config.bindings.global.regexRules : [];
                targetRules = config.bindings.global.regexRules;
            }

            const existingKeys = new Set(targetRules.map((rule) => `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`));
            const nextRules = importedRules.filter((rule) => {
                const key = `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`;
                if (existingKeys.has(key)) {
                    return false;
                }
                existingKeys.add(key);
                return true;
            });

            targetRules.push(...nextRules);
            regexProcessor.updateConfig(config.regex || {}, getCharacterBinding(config.chat?.defaultCharacter || '')?.regexRules || [], config.preset?.regexRules || [], config.bindings.global.regexRules || []);
            saveConfig(config);
            res.json({
                success: true,
                count: nextRules.length,
                importedRules: nextRules,
                diagnostics,
                targetLayer,
                message: `已导入 ${nextRules.length} 条规则到${targetLayer === 'preset' ? '预设层' : targetLayer === 'character' ? '角色层' : '全局层'}`
            });
        } catch (error) {
            logger.error(`[API ${req.requestId || 'no-id'}] 导入正则规则失败`, {
                message: error.message,
                stack: error.stack,
                bodyPreview: summarizePayload(req.body, 1200)
            });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/regex/export', requireAuth, (req, res) => {
        const format = req.query.format === 'sillytavern' ? 'sillytavern' : 'native';
        const payload = RegexProcessor.exportRules(regexProcessor.getRules().filter((rule) => rule.source !== 'preset'), format);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=regex-${format}-${Date.now()}.json`);
        res.send(JSON.stringify(payload, null, 2));
    });

    app.post('/api/preset/import', requireAuth, (req, res) => {
        try {
            logger.info(`[API ${req.requestId || 'no-id'}] preset import started`, {
                bodyPreview: summarizePayload(req.body, 1200)
            });
            const preset = PromptBuilder.importPreset(req.body);
            const diagnostics = PromptBuilder.diagnosePresetImport(req.body);
            const importedRegexRules = RegexProcessor.importRules(req.body);
            const regexDiagnostics = RegexProcessor.diagnoseImport(req.body);
            logger.info(`[API ${req.requestId || 'no-id'}] preset import diagnostics`, diagnostics);
            logger.info(`[API ${req.requestId || 'no-id'}] preset-linked regex diagnostics`, regexDiagnostics);
            config.preset = {
                ...(config.preset || {}),
                ...preset,
                regexRules: importedRegexRules
            };
            regexProcessor.updateConfig(config.regex || {}, null, config.preset?.regexRules || [], config.bindings?.global?.regexRules || config.regex?.rules || []);
            promptBuilder.updateConfig(config);
            saveConfig(config);
            res.json({
                success: true,
                preset: config.preset,
                diagnostics,
                regexDiagnostics,
                importedRegexCount: importedRegexRules.length,
                importedFields: Object.keys(preset).filter((key) => preset[key] !== '' && preset[key] !== false),
                message: importedRegexRules.length > 0 ? `预设已导入，并同步导入 ${importedRegexRules.length} 条正则` : '预设已导入'
            });
        } catch (error) {
            logger.error(`[API ${req.requestId || 'no-id'}] 导入预设失败`, {
                message: error.message,
                stack: error.stack,
                bodyPreview: summarizePayload(req.body, 1200)
            });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/preset/export', requireAuth, (req, res) => {
        const format = req.query.format === 'sillytavern' ? 'sillytavern' : 'native';
        const payload = PromptBuilder.exportPreset(config.preset || {}, format);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=preset-${format}-${Date.now()}.json`);
        res.send(JSON.stringify(payload, null, 2));
    });

    // OneBot 重连（需要认证）
    app.post('/api/status/onebot/reconnect', requireAuth, (req, res) => {
        if (bot) {
            bot.reconnect();
            res.json({ success: true, message: '正在重新连接...' });
        } else {
            res.status(500).json({ success: false, error: 'OneBot 客户端未初始化' });
        }
    });

    logger.info('API 路由已设置');
}
