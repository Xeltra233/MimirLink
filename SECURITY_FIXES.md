# 安全修复记录 - 2026-05-16

## 修复的安全漏洞

### 1. 文件上传路径遍历 (CVE-级别: 高危)
**位置**: `src/routes.js:1316-1350`

**问题**: 
- 直接使用用户上传的文件名，未过滤路径遍历字符
- 攻击者可上传 `../../etc/passwd` 等路径

**修复**:
```javascript
// 过滤路径分隔符和路径遍历
const safeName = originalName
    .replace(/\\/g, '_')
    .replace(/\//g, '_')
    .replace(/\.\./g, '_');
```

### 2. JSON.parse DoS 攻击 (CVE-级别: 中危)
**位置**: `src/character.js`, `src/worldbook.js`

**问题**:
- 直接解析外部 JSON 数据，无大小限制
- 恶意大文件可导致内存溢出

**修复**:
- 新增 `src/json-utils.js` 工具模块
- 限制角色卡 5MB，世界书 10MB
```javascript
const character = safeJsonParse(jsonStr, 5 * 1024 * 1024);
```

### 3. 文件名长度未限制 (CVE-级别: 低危)
**位置**: `src/routes.js:121`

**问题**:
- `sanitizeFilename` 仅替换字符，未限制长度
- 可能导致文件系统错误

**修复**:
- 限制 200 字符
- 智能保留文件扩展名

## 修复的运行逻辑问题

### 4. 数据库连接泄漏
**位置**: `src/session.js:251-281`

**问题**:
- 切换数据库时未清理 prepared statements
- 可能导致 "database is locked" 错误

**修复**:
```javascript
closeStatements() {
    // 清理所有 prepared statements
    for (const name of statements) {
        if (this[name]) {
            this[name] = null;
        }
    }
}
```

### 5. WebSocket 重连风暴
**位置**: `src/onebot.js:148-180`

**问题**:
- 固定 5 秒重连，网络故障时频繁重试
- 可能导致服务端压力

**修复**:
- 实现指数退避：5s → 10s → 20s → 40s → 60s (最大)
```javascript
const delay = Math.min(
    baseDelay * Math.pow(2, this.reconnectAttempts - 1),
    this.maxReconnectDelay
);
```

### 6. 内存泄漏
**位置**: `src/runtime.js:58-84`

**问题**:
- `seenMessages` Map 仅在 enqueue 时清理
- 长时间运行后无限增长

**修复**:
- 添加定时清理器（每 30 秒）
- 添加 `destroy()` 方法清理所有 timer

### 7. 错误静默吞没
**位置**: `src/routes.js:5452`, `src/variable-bridge.js:99`

**问题**:
- 空 catch 块，无日志
- 排查问题困难

**修复**:
```javascript
catch (error) {
    logger.error?.('[模块] 操作失败', { error: error.message });
}
```

### 8. 日志敏感数据泄漏
**位置**: `src/routes.js:125-135`

**问题**:
- 请求日志包含完整 body
- 可能泄漏密码、token

**修复**:
```javascript
const sensitiveKeys = ['password', 'apiKey', 'accessToken', 'sessionSecret', 'secret', 'token'];
for (const key of sensitiveKeys) {
    if (key in sanitized) {
        sanitized[key] = '******';
    }
}
```

## 未修复的问题

### 密码明文存储
**原因**: 需要破坏性变更（现有密码需重置）

**建议**: 
1. 安装 bcrypt: `npm install bcrypt`
2. 迁移脚本：读取现有密码 → 生成哈希 → 更新配置
3. 登录逻辑改为 `bcrypt.compare()`

## 测试建议

1. **文件上传测试**:
   ```bash
   # 尝试上传路径遍历文件名
   curl -F "file=@test.png;filename=../../etc/passwd" http://localhost:8001/api/characters/upload
   ```

2. **大文件测试**:
   ```bash
   # 生成 20MB 的 JSON 文件
   dd if=/dev/zero bs=1M count=20 | base64 > large.json
   # 尝试上传，应被拒绝
   ```

3. **WebSocket 重连测试**:
   - 断开 OneBot 连接
   - 观察日志中的重连间隔是否递增

4. **内存泄漏测试**:
   - 运行 24 小时
   - 监控 `runtime.getStats().queuedDedupes` 是否稳定

## 版本信息

- 修复日期: 2026-05-16
- 修复人: Claude Opus 4.6
- 影响版本: MimirLink v1.1.0
- 修复后版本: v1.1.1 (建议)
