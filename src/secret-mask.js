/**
 * 配置密钥脱敏（用于备份导出、配置读取等对外输出路径）
 *
 * 规则：
 * - 字段名命中固定密钥名单（apiKey / accessToken / password / sessionSecret / secret / token，不区分大小写）→ 掩码
 * - 密钥容器（headers / env / apiKeys）内，字段名含 key / token / secret / password / auth / cookie 等特征 → 掩码
 * - 其余字段原样保留，避免误伤模型 ID、模式名等普通字符串
 */

const MASK_VALUE = '******';
const MASK_KEYS = new Set(['apikey', 'accesstoken', 'password', 'sessionsecret', 'secret', 'token']);
const SECRET_CONTAINERS = new Set(['headers', 'env', 'apikeys']);
const SECRET_KEY_PATTERN = /(key|token|secret|passw(or)?d|credential|cookie|auth)/i;

export function maskConfigSecrets(config) {
    if (config === undefined || config === null) return {};
    const masked = JSON.parse(JSON.stringify(config));

    function walk(node, containerKey = '') {
        if (!node || typeof node !== 'object') return;
        const insideSecretContainer = SECRET_CONTAINERS.has(containerKey);
        // apiKeys 是「服务名 → 密钥」映射，容器内所有字符串都按密钥处理
        const maskAllStrings = containerKey === 'apikeys';
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (value && typeof value === 'object') {
                walk(value, String(key).toLowerCase());
                continue;
            }
            if (typeof value !== 'string' || value.length === 0) continue;
            const normalizedKey = String(key).toLowerCase();
            if (maskAllStrings || MASK_KEYS.has(normalizedKey) || (insideSecretContainer && SECRET_KEY_PATTERN.test(normalizedKey))) {
                node[key] = MASK_VALUE;
            }
        }
    }

    walk(masked);
    return masked;
}

export { MASK_VALUE };
