/**
 * JSON 解析工具 - 带大小限制防止 DoS
 */

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 安全的 JSON.parse，带大小限制
 * @param {string} text - JSON 字符串
 * @param {number} maxSize - 最大字节数
 * @returns {any} 解析后的对象
 * @throws {Error} 超过大小限制或解析失败
 */
export function safeJsonParse(text, maxSize = DEFAULT_MAX_SIZE) {
    if (!text) {
        throw new Error('JSON 文本为空');
    }

    const size = Buffer.byteLength(text, 'utf8');
    if (size > maxSize) {
        throw new Error(`JSON 大小超限: ${size} 字节 (最大 ${maxSize} 字节)`);
    }

    return JSON.parse(text);
}

/**
 * 安全的 JSON.parse，带大小限制和回退值
 * @param {string} text - JSON 字符串
 * @param {any} fallback - 解析失败时的回退值
 * @param {number} maxSize - 最大字节数
 * @returns {any} 解析后的对象或回退值
 */
export function safeJsonParseWithFallback(text, fallback, maxSize = DEFAULT_MAX_SIZE) {
    if (!text) {
        return fallback;
    }

    try {
        const size = Buffer.byteLength(text, 'utf8');
        if (size > maxSize) {
            console.warn(`[JSON] 大小超限: ${size} 字节，返回回退值`);
            return fallback;
        }

        return JSON.parse(text);
    } catch (error) {
        console.warn(`[JSON] 解析失败: ${error.message}，返回回退值`);
        return fallback;
    }
}

/**
 * 从文件读取并解析 JSON，带大小限制
 * @param {string} filePath - 文件路径
 * @param {number} maxSize - 最大字节数
 * @returns {any} 解析后的对象
 */
export async function safeJsonParseFile(filePath, maxSize = DEFAULT_MAX_SIZE) {
    const fs = await import('fs');
    const stats = fs.statSync(filePath);

    if (stats.size > maxSize) {
        throw new Error(`文件大小超限: ${stats.size} 字节 (最大 ${maxSize} 字节)`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
}
