/**
 * 从 sessions.json 按 session_id 提取聊天记录
 * 保持原始消息格式，不做ID替换
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
    console.log('='.repeat(60));
    console.log('聊天记录提取工具');
    console.log('='.repeat(60));
    console.log();

    const sessionsPath = path.join(__dirname, 'sessions.json');
    
    if (!fs.existsSync(sessionsPath)) {
        console.error('❌ 错误：找不到 sessions.json 文件');
        console.log(`期望路径：${sessionsPath}`);
        rl.close();
        return;
    }

    let sessionsArray;
    try {
        const content = fs.readFileSync(sessionsPath, 'utf8');
        sessionsArray = JSON.parse(content);
    } catch (error) {
        console.error('❌ 错误：无法解析 sessions.json');
        console.error(error.message);
        rl.close();
        return;
    }

    console.log('📊 找到以下会话：');
    console.log('-'.repeat(60));

    const validSessions = [];
    
    sessionsArray.forEach(([sessionId, sessionData]) => {
        if (!sessionData || !Array.isArray(sessionData.messages)) {
            return;
        }
        
        const msgCount = sessionData.messages.length;
        validSessions.push({
            index: validSessions.length + 1,
            sessionId,
            messageCount: msgCount,
            sessionData
        });
        
        console.log(`${validSessions.length}. ${sessionId} (${msgCount} 条消息)`);
    });

    console.log('-'.repeat(60));
    console.log();
    console.log('💡 提示：如不确定选哪个，可以把这个列表发给AI分析');
    console.log();

    const selection = await question('请输入序号：');
    const num = parseInt(selection);
    
    if (num < 1 || num > validSessions.length) {
        console.error('❌ 无效的序号');
        rl.close();
        return;
    }

    const selected = validSessions[num - 1];
    const messages = selected.sessionData.messages;

    console.log();
    console.log(`✅ 已选择: ${selected.sessionId}`);
    console.log(`   消息数量: ${messages.length} 条`);
    console.log();

    const limitInput = await question(`要提取多少条消息？（留空提取全部 ${messages.length} 条）：`);
    const limit = limitInput.trim() ? parseInt(limitInput) : messages.length;

    if (isNaN(limit) || limit <= 0) {
        console.error('❌ 无效的条数');
        rl.close();
        return;
    }

    console.log();
    console.log(`✅ 将提取最近 ${Math.min(limit, messages.length)} 条消息`);
    console.log();

    // 提取消息（保持原样）
    const selectedMessages = messages.slice(-limit);

    const convertedMessages = selectedMessages.map(msg => {
        return {
            sessionId: 'global_shared_memory',
            role: msg.role,
            content: msg.content, // 保持原始内容
            timestamp: msg.timestamp || Date.now(),
            date: msg.date || new Date().toISOString()
        };
    });

    // 保存文件
    const outputPath = path.join(__dirname, 'global_memory.json');
    const backupPath = path.join(__dirname, `global_memory.backup.${Date.now()}.json`);

    if (fs.existsSync(outputPath)) {
        console.log(`⚠️  检测到现有文件，备份为：${path.basename(backupPath)}`);
        fs.copyFileSync(outputPath, backupPath);
    }

    fs.writeFileSync(outputPath, JSON.stringify(convertedMessages, null, 2), 'utf8');

    console.log();
    console.log('='.repeat(60));
    console.log('✅ 转换完成！');
    console.log('-'.repeat(60));
    console.log(`输出文件：${outputPath}`);
    console.log(`消息条数：${convertedMessages.length}`);
    console.log(`会话ID：global_shared_memory`);
    console.log('='.repeat(60));
    console.log();
    console.log('📝 示例输出（前5条）：');
    console.log('-'.repeat(60));
    
    convertedMessages.slice(0, 5).forEach((msg, index) => {
        const preview = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
        console.log(`${index + 1}. [${msg.role}] ${preview}`);
    });
    
    if (convertedMessages.length > 5) {
        console.log('...');
        const lastMsg = convertedMessages[convertedMessages.length - 1];
        const lastPreview = lastMsg.content.length > 100 ? lastMsg.content.substring(0, 100) + '...' : lastMsg.content;
        console.log(`${convertedMessages.length}. [${lastMsg.role}] ${lastPreview}`);
    }
    
    console.log('-'.repeat(60));
    console.log();
    console.log('💡 将生成的 global_memory.json 复制到');
    console.log('   Tavern-Link 项目的 data/chats/ 目录即可使用');

    rl.close();
}

main().catch(error => {
    console.error('❌ 运行出错：', error);
    console.error(error.stack);
    rl.close();
});
