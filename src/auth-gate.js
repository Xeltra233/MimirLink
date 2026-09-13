import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 面板登录网关与 MCP 令牌校验。
 *
 * 设计：
 * - 未启用面板登录（auth.enabled !== true）时全部放行，与旧行为一致。
 * - 启用后只放行：登录页、三个认证接口、以及携带正确 MCP 令牌的 MCP 端点请求。
 * - MCP 令牌未配置时不放行，外部客户端必须已有面板会话（默认更安全）。
 */

/** 固定长度摘要比较，避免长度与内容泄漏 */
export function safeEqualStrings(a, b) {
    const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
    const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
    return timingSafeEqual(ha, hb);
}

/** 端点路径归一化：补前导斜杠、去尾部斜杠 */
export function normalizeMcpPath(value) {
    const raw = String(value || '').trim();
    const withSlash = raw.startsWith('/') ? raw : `/${raw || 'mcp'}`;
    return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

/** 从请求中取 MCP 令牌：Authorization: Bearer <token> 或 X-MCP-Token */
export function extractMcpToken(req = {}) {
    const authorization = String(req.headers?.authorization || '').trim();
    const bearer = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearer) {
        return bearer[1].trim();
    }
    const headerToken = req.headers?.['x-mcp-token'];
    return typeof headerToken === 'string' ? headerToken.trim() : '';
}

/** 请求是否携带与配置一致的非空 MCP 令牌 */
export function isMcpTokenAuthorized(req, config = {}) {
    const expected = String(config.mcp?.token || '').trim();
    if (!expected) {
        return false;
    }
    const provided = extractMcpToken(req);
    return provided.length > 0 && safeEqualStrings(provided, expected);
}

/**
 * 创建面板鉴权网关。仅在 auth.enabled === true 时生效。
 * @param {object} config 运行配置（读取 auth / mcp）
 * @returns {import('express').RequestHandler}
 */
export function createPanelAuthGate(config = {}) {
    const publicAuthPaths = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/logout']);
    return function panelAuthGate(req, res, next) {
        if (config.auth?.enabled !== true) {
            return next();
        }
        if (req.session?.authenticated === true) {
            return next();
        }

        const requestPath = req.path || '/';
        if (requestPath === '/login.html' || publicAuthPaths.has(requestPath)) {
            return next();
        }
        if (requestPath === normalizeMcpPath(config.mcp?.path) && isMcpTokenAuthorized(req, config)) {
            return next();
        }

        if (requestPath.startsWith('/api/')) {
            return res.status(401).json({ error: '未登录' });
        }
        return res.redirect('/login.html');
    };
}
