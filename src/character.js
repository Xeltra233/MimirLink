/**
 * 角色卡管理模块
 * 兼容 SillyTavern PNG 格式
 */

import fs from 'fs';
import path from 'path';

export class CharacterManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.charactersDir = path.join(dataDir, 'characters');
        this.overridesDir = path.join(dataDir, 'character_overrides');
        this.cache = new Map();
        this.currentCharacter = null;
        
        // 确保覆盖层目录存在
        if (!fs.existsSync(this.overridesDir)) {
            fs.mkdirSync(this.overridesDir, { recursive: true });
        }
    }

    /**
     * 从 PNG 文件读取角色数据
     * SillyTavern 将角色数据存储在 PNG 的 tEXt 块中
     * 如果存在覆盖层文件，会合并覆盖层的数据
     */
    readFromPng(characterName) {
        // 检查缓存
        if (this.cache.has(characterName)) {
            return this.cache.get(characterName);
        }

        const pngPath = path.join(this.charactersDir, characterName + '.png');
        
        if (!fs.existsSync(pngPath)) {
            throw new Error(`角色文件不存在: ${pngPath}`);
        }

        const buffer = fs.readFileSync(pngPath);
        let offset = 8; // 跳过 PNG 签名
        let character = null;

        while (offset < buffer.length) {
            const length = buffer.readUInt32BE(offset);
            const type = buffer.toString('ascii', offset + 4, offset + 8);

            if (type === 'tEXt' || type === 'iTXt') {
                const chunkData = buffer.slice(offset + 8, offset + 8 + length);
                const nullIndex = chunkData.indexOf(0);

                if (nullIndex !== -1) {
                    const keyword = chunkData.toString('ascii', 0, nullIndex);

                    if (keyword === 'chara') {
                        let dataStart = nullIndex + 1;

                        // iTXt 格式需要跳过额外的字段
                        if (type === 'iTXt') {
                            // 跳过压缩标志和压缩方法
                            while (dataStart < chunkData.length && chunkData[dataStart] === 0) dataStart++;
                            // 跳过语言标签
                            while (dataStart < chunkData.length && chunkData[dataStart] !== 0) dataStart++;
                            dataStart++;
                            // 跳过翻译关键字
                            while (dataStart < chunkData.length && chunkData[dataStart] !== 0) dataStart++;
                            dataStart++;
                        }

                        const base64Data = chunkData.toString('utf8', dataStart);
                        const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
                        character = JSON.parse(jsonStr);
                        break;
                    }
                }
            }

            offset += 12 + length; // 4(length) + 4(type) + length + 4(crc)
        }

        if (!character) {
            throw new Error('无法从 PNG 文件中读取角色数据');
        }

        // 检查是否有覆盖层文件
        const overridePath = path.join(this.overridesDir, characterName + '.json');
        if (fs.existsSync(overridePath)) {
            try {
                const overrideData = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
                // 合并覆盖层数据
                character = { ...character, ...overrideData };
            } catch (e) {
                console.error(`读取覆盖层文件失败: ${overridePath}`, e);
            }
        }

        // 缓存结果
        this.cache.set(characterName, character);
        return character;
    }

    /**
     * 更新角色数据（保存到覆盖层文件）
     * @param {string} characterName - 角色名称（不含扩展名）
     * @param {Object} updates - 要更新的字段
     * @returns {Object} 更新后的完整角色数据
     */
    updateCharacter(characterName, updates) {
        this.cache.delete(characterName);

        const pngPath = path.join(this.charactersDir, characterName + '.png');
        if (!fs.existsSync(pngPath)) {
            throw new Error(`角色文件不存在: ${pngPath}`);
        }

        // 读取原始 PNG 数据
        const buffer = fs.readFileSync(pngPath);
        const currentChar = this.readFromPng(characterName);

        // 也读取覆盖层（保留 MimirLink 独有字段如 worldbook 绑定等）
        const overridePath = path.join(this.overridesDir, characterName + '.json');
        let overrides = {};
        if (fs.existsSync(overridePath)) {
            try { overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8')); } catch {}
        }

        // ST 卡字段 → 写入 PNG；MimirLink 独有字段 → 写入覆盖层
        const stFields = ['name','description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions','creator_notes','creatorcomment','talkativeness','fav','tags','alternate_greetings','extensions','character_book'];
        const stUpdates = {};
        const localUpdates = {};
        for (const [k, v] of Object.entries(updates)) {
            if (stFields.includes(k)) stUpdates[k] = v;
            else localUpdates[k] = v;
        }

        // 写 ST 字段回 PNG
        if (Object.keys(stUpdates).length > 0) {
            const updated = { ...currentChar, ...stUpdates };
            if (updated.data) Object.assign(updated.data, stUpdates);
            const jsonStr = JSON.stringify(updated);
            const base64Str = Buffer.from(jsonStr, 'utf8').toString('base64');

            // 找到 chara chunk 并替换
            let offset = 8;
            const chunks = [];
            while (offset < buffer.length) {
                const length = buffer.readUInt32BE(offset);
                const type = buffer.toString('ascii', offset + 4, offset + 8);
                const chunkData = buffer.slice(offset + 8, offset + 8 + length);

                if (type === 'tEXt' || type === 'iTXt') {
                    const nullIdx = chunkData.indexOf(0);
                    if (nullIdx !== -1) {
                        const keyword = chunkData.toString('ascii', 0, nullIdx);
                        if (keyword === 'chara') {
                            // 替换这个 chunk
                            const newKeyword = Buffer.from('chara\0', 'ascii');
                            const newData = Buffer.concat([newKeyword, Buffer.from(base64Str, 'utf8')]);
                            const newLength = Buffer.alloc(4);
                            newLength.writeUInt32BE(newData.length, 0);
                            const newType = Buffer.from('tEXt', 'ascii');
                            const crcData = Buffer.concat([newType, newData]);
                            const crc = crc32(crcData);
                            const crcBuf = Buffer.alloc(4);
                            crcBuf.writeUInt32BE(crc, 0);
                            chunks.push(Buffer.concat([newLength, newType, newData, crcBuf]));
                            offset += 12 + length;
                            continue;
                        }
                    }
                }
                // 保留原 chunk
                chunks.push(buffer.slice(offset, offset + 12 + length));
                offset += 12 + length;
            }

            // 写回文件
            const pngSig = Buffer.alloc(8);
            pngSig.write('\x89PNG\r\n\x1a\n', 0, 8, 'ascii');
            fs.writeFileSync(pngPath, Buffer.concat([pngSig, ...chunks]));
        }

        // 写 MimirLink 独有字段到覆盖层，同时删除已写回PNG的ST字段
        if (Object.keys(localUpdates).length > 0) {
            const newOverrides = { ...overrides, ...localUpdates };
            for (const f of stFields) delete newOverrides[f];
            fs.writeFileSync(overridePath, JSON.stringify(newOverrides, null, 2), 'utf-8');
        } else if (Object.keys(stUpdates).length > 0 && Object.keys(overrides).length > 0) {
            // 有ST更新但无本地更新：清理覆盖层中的ST字段
            for (const f of stFields) delete overrides[f];
            fs.writeFileSync(overridePath, JSON.stringify(overrides, null, 2), 'utf-8');
        }

        // 清除并重读
        this.cache.delete(characterName);
        const updatedCharacter = this.readFromPng(characterName);
        if (this.currentCharacter && this.currentCharacter.name === updatedCharacter.name) {
            this.currentCharacter = updatedCharacter;
        }
        return updatedCharacter;
    }

    /**
     * 获取所有角色列表
     */
    listCharacters() {
        if (!fs.existsSync(this.charactersDir)) {
            return [];
        }

        const files = fs.readdirSync(this.charactersDir);
        return files
            .filter(f => f.endsWith('.png'))
            .map(f => f.replace('.png', ''));
    }

    /**
     * 获取角色信息（简要）
     */
    getCharacterInfo(characterName) {
        const character = this.readFromPng(characterName);
        return {
            name: character.name,
            description: character.description?.substring(0, 200) + '...',
            personality: character.personality?.substring(0, 100) + '...',
            hasFirstMessage: !!character.first_mes,
            hasSystemPrompt: !!character.system_prompt
        };
    }

    /**
     * 清除缓存
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * 获取当前选中的角色
     */
    getCurrentCharacter() {
        return this.currentCharacter;
    }

    /**
     * 加载并设置当前角色
     */
    loadCharacter(characterName) {
        const character = this.readFromPng(characterName);
        this.currentCharacter = character;
        return character;
    }

    /**
     * 扫描角色目录（刷新列表）
     */
    scanCharacters() {
        this.clearCache();
        return this.listCharacters();
    }

    extractSillyTavernMetadata(characterName) {
        const character = this.readFromPng(characterName);
        const data = character.data || {};
        const extensions = character.extensions || data.extensions || {};
        const characterBook = character.character_book || data.character_book || null;
        const depthPrompt = extensions.depth_prompt || {};
        const regexScripts = extensions.regex_scripts || character.regex_scripts || data.regex_scripts || [];
        const explicitAssistantPrefill = character.assistant_prefill
            || data.assistant_prefill
            || extensions.assistant_prefill
            || '';

        return {
            character,
            metadata: {
                name: character.name || data.name || characterName,
                spec: character.spec || data.spec || '',
                specVersion: character.spec_version || data.spec_version || '',
                hasEmbeddedWorldBook: !!characterBook,
                worldBookEntries: Array.isArray(characterBook?.entries)
                    ? characterBook.entries.length
                    : Object.keys(characterBook?.entries || {}).length,
                worldBook: characterBook,
                tags: Array.from(new Set([...(character.tags || []), ...(data.tags || [])])),
                creatorNotes: character.creator_notes || data.creator_notes || character.creatorcomment || '',
                alternateGreetings: character.alternate_greetings || data.alternate_greetings || [],
                postHistoryInstructions: character.post_history_instructions || data.post_history_instructions || '',
                systemPrompt: character.system_prompt || data.system_prompt || '',
                preferredPreset: {
                    name: '',
                    systemPrompt: depthPrompt.prompt || character.system_prompt || data.system_prompt || '',
                    postHistoryInstructions: character.post_history_instructions || data.post_history_instructions || '',
                    assistantPrefill: explicitAssistantPrefill
                },
                regexScripts: Array.isArray(regexScripts) ? regexScripts : []
            }
        };
    }
}

function crc32(data) {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
