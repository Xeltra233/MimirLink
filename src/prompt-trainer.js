/**
 * 角色提示词训练器
 * 隔离运行，不污染聊天会话。读取角色卡+聊天记录，迭代优化提示词。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadCharacterData(config) {
    const charName = config.chat?.defaultCharacter || '';
    const pngPath = path.join(ROOT_DIR, 'public', 'characters', charName + '.png');
    if (!fs.existsSync(pngPath)) return { name: charName, raw: {} };

    const buffer = fs.readFileSync(pngPath);
    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'tEXt' || type === 'iTXt') {
            const chunkData = buffer.slice(offset + 8, offset + 8 + length);
            const nullIndex = chunkData.indexOf(0);
            if (nullIndex !== -1 && chunkData.toString('ascii', 0, nullIndex) === 'chara') {
                let dataStart = nullIndex + 1;
                const base64Data = chunkData.toString('utf8', dataStart);
                const jsonStr = Buffer.from(base64Data, 'base64').toString('utf8');
                return { name: charName, raw: JSON.parse(jsonStr) };
            }
        }
        offset += 12 + length;
    }
    return { name: charName, raw: {} };
}

async function loadChatHistory(dbPath, limit = 30) {
    try {
        const Database = (await import('better-sqlite3')).default;
        const fullPath = path.resolve(ROOT_DIR, dbPath);
        console.log('[训练器] 尝试读取:', fullPath, 'exists:', fs.existsSync(fullPath));
        if (!fs.existsSync(fullPath)) return [];
        const db = new Database(fullPath, { readonly: true });
        const count = db.prepare('SELECT COUNT(*) as c FROM messages').get();
        console.log('[训练器] 消息总数:', count?.c || 0);
        // 尝试不同列名
        let rows;
        try {
            rows = db.prepare(
                'SELECT role, content FROM messages WHERE content IS NOT NULL AND length(content) > 10 ORDER BY rowid DESC LIMIT ?'
            ).all(limit);
        } catch {
            rows = db.prepare(
                'SELECT role, content FROM messages WHERE content IS NOT NULL LIMIT ?'
            ).all(limit);
        }
        db.close();
        console.log('[训练器] 加载了', rows.length, '条有效消息');
        return rows.reverse();
    } catch (e) {
        console.error('[训练器] 读取数据库失败:', dbPath, e.message);
        return [];
    }
}

function buildCharacterProfile(cardData, raw) {
    const data = raw?.data || raw || {};
    return {
        name: cardData.name,
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
        firstMessage: data.first_mes || '',
        examples: data.mes_example || '',
    };
}

function buildTrainingSystemPrompt(profile) {
    return `你是一位世界级的角色扮演 AI 提示词工程专家。你的专长是分析和优化系统提示词（system prompt），让 AI 在角色扮演中做到极致的人设还原。

## 你的分析框架

你会从以下维度评估 AI 的回复是否符合角色人设：

1. **语气一致性** — 用词、句式、口头禅是否和角色设定一致
2. **行为逻辑** — 角色的动机、反应、决策是否符合其性格和背景
3. **知识边界** — 角色是否说了不该知道的事，或没提该知道的事
4. **情感层次** — 情感的强度、转变、细腻程度是否到位
5. **对话风格** — 话多话少、主动被动、攻击性/温和性等
6. **避免模板化** — 是否出现了"八股文"式的统一回复结构

## 当前角色设定

**角色名**：${profile.name}
**描述**：${profile.description?.substring(0, 800) || '无'}
**性格**：${profile.personality?.substring(0, 500) || '无'}
**场景**：${profile.scenario?.substring(0, 300) || '无'}
**开场白**：${profile.firstMessage?.substring(0, 300) || '无'}
**对话范例**：${profile.examples?.substring(0, 500) || '无'}`;
}

async function sendToAI(systemPrompt, userMessage, config) {
    const aiConfig = config.ai || {};
    const provider = aiConfig.providers?.find(p => p.id === aiConfig.activeProviderId) || aiConfig.providers?.[0] || {};
    const baseUrl = provider.baseUrl || aiConfig.baseUrl || 'https://api.openai.com/v1';
    const apiKey = provider.apiKey || aiConfig.apiKey || '';
    const model = provider.model || aiConfig.model || '';
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            temperature: 0.4,
            max_tokens: 4096
        }),
        signal: AbortSignal.timeout(aiConfig.timeout || 60000)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`AI API ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

/**
 * 单轮分析：给 AI 看一段对话，让它评判人设符合度并提出提示词改进
 */
async function analyzeRound(systemPrompt, profile, chatSample, round, config) {
    const userLines = chatSample.filter(m => m.role === 'user').slice(-3);
    const aiLines = chatSample.filter(m => m.role === 'assistant').slice(-3);

    if (aiLines.length === 0) return null;

    const sampleText = [
        '## 对话样本',
        ...userLines.map((m, i) => `用户: ${m.content?.substring(0, 300)}`),
        ...aiLines.map((m, i) => `AI: ${m.content?.substring(0, 500)}`),
    ].join('\n');

    const analysisPrompt = `${sampleText}

## 任务

分析以上 AI 回复在多大程度上符合角色"${profile.name}"的人设。从以下角度逐条评价：

1. 语气是否贴合角色？哪里不像？
2. 行为和角色设定矛盾吗？
3. 有没有模板化的痕迹（固定句式、过度格式化）？
4. 情感表达是否符合角色性格？

然后**输出一个 JSON 对象**，包含：
- score: 人设符合度评分（0-100）
- issues: 发现的具体问题（数组，每项一句话）
- fixPrompt: 如果要修改当前提示词来修复这些问题，新的提示词内容应该是什么

只输出 JSON：{"score":75,"issues":["问题1","问题2"],"fixPrompt":"修改后的完整提示词文本"}`;

    const result = await sendToAI(systemPrompt, analysisPrompt, config);

    // 提取 JSON
    try {
        const m = result.match(/```json\s*([\s\S]*?)```/) || result.match(/```\s*([\s\S]*?)```/) || result.match(/(\{[\s\S]*\})/);
        if (m) return JSON.parse(m[1] || m[0]);
    } catch {}

    try {
        return JSON.parse(result.trim());
    } catch {}

    return { score: 0, issues: ['无法解析分析结果'], fixPrompt: '', raw: result.substring(0, 500) };
}

/**
 * 运行完整的训练流程
 */
export async function runPromptTraining(options = {}) {
    const config = options.config || loadConfig();
    const roundLimit = options.rounds || 50;
    const profile = buildCharacterProfile(
        loadCharacterData(config),
        loadCharacterData(config).raw
    );

    // 尝试多个可能的数据库路径
    const dbPaths = [
        config.activeMemory?.dbPath,
        config.globalMemory?.storage?.path,
        config.memory?.storage?.path,
        './data/chats/memory-store.sqlite',
        `./data/chats/characters/${config.chat?.defaultCharacter || ''}.sqlite`
    ].filter(Boolean);

    let allMessages = [];
    for (const dbPath of dbPaths) {
        allMessages = await loadChatHistory(dbPath, 100);
        if (allMessages.length > 0) break;
    }
    if (allMessages.length === 0) {
        return { success: false, error: '没有可用的聊天记录进行训练' };
    }

    const systemPrompt = buildTrainingSystemPrompt(profile);
    const results = [];
    const bestFixes = new Map(); // identifier → { score, content, count }

    console.log(`[训练器] 开始 ${roundLimit} 轮训练，角色: ${profile.name}，样本: ${allMessages.length} 条消息`);

    for (let round = 1; round <= roundLimit; round++) {
        // 随机采样 6-12 条消息作为一轮
        const sampleSize = 6 + Math.floor(Math.random() * 7);
        const startIdx = Math.max(0, Math.floor(Math.random() * (allMessages.length - sampleSize)));
        const sample = allMessages.slice(startIdx, startIdx + sampleSize);

        try {
            const analysis = await analyzeRound(systemPrompt, profile, sample, round, config);
            if (!analysis || analysis.score === undefined) continue;

            results.push({
                round,
                score: analysis.score,
                issues: analysis.issues || [],
                fixPrompt: analysis.fixPrompt || '',
                sampleRange: `${startIdx}-${startIdx + sampleSize}`
            });

            // 累加最佳修复
            if (analysis.score < 80 && analysis.fixPrompt && analysis.fixPrompt.length > 20) {
                const key = `fix-${round}`;
                if (!bestFixes.has(key) || analysis.score > (bestFixes.get(key)?.score || 0)) {
                    bestFixes.set(key, { score: analysis.score, content: analysis.fixPrompt });
                }
            }

            console.log(`[训练器] 第 ${round}/${roundLimit} 轮 评分: ${analysis.score} 问题: ${(analysis.issues||[]).length} 个`);
        } catch (e) {
            console.error(`[训练器] 第 ${round} 轮失败:`, e.message);
        }

        // 避免 API 限流
        if (round < roundLimit) await new Promise(r => setTimeout(r, 500));
    }

    // 汇总结果
    const validResults = results.filter(r => r.score > 0);
    const avgScore = validResults.length > 0
        ? (validResults.reduce((s, r) => s + r.score, 0) / validResults.length).toFixed(1)
        : 0;

    const allIssues = validResults.flatMap(r => r.issues || []);
    const issueFrequency = {};
    allIssues.forEach(i => { const key = i.substring(0, 80); issueFrequency[key] = (issueFrequency[key] || 0) + 1; });
    const topIssues = Object.entries(issueFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([issue, count]) => ({ issue, count }));

    const topFixes = [...bestFixes.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(f => f.content);

    console.log(`[训练器] 完成 ${validResults.length}/${roundLimit} 轮有效训练，平均评分: ${avgScore}`);

    return {
        success: true,
        profile: { name: profile.name, description: profile.description?.substring(0, 300) },
        rounds: roundLimit,
        completedRounds: validResults.length,
        averageScore: avgScore,
        topIssues,
        recommendedFixes: topFixes,
        detailedResults: results.slice(-20)
    };
}
