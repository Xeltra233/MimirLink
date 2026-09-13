import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';

import { McpClientManager, normalizeMcpClientConfig, mergeMcpSecrets, maskMcpServerForClient } from '../src/mcp-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureServer = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function stdioServer(overrides = {}) {
    return {
        id: 'test-stdio',
        name: 'echo-server',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [fixtureServer],
        env: { TEST_KEY: 'hello-env' },
        timeoutMs: 15000,
        toolFilter: { include: [], exclude: [] },
        ...overrides
    };
}

async function createHttpMcpServer(toolOverrides = {}) {
    const tools = toolOverrides.tools || [
        { name: 'ping2', description: 'HTTP 测试工具', inputSchema: { type: 'object', properties: {} } },
        { name: 'fail2', description: 'HTTP 错误工具', inputSchema: { type: 'object', properties: {} } }
    ];
    const httpServer = createServer(async (req, res) => {
        const chunks = [];
        if (req.method === 'POST') {
            for await (const chunk of req) {
                chunks.push(chunk);
            }
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => transport.close());
        const server = new Server({ name: 'http-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const name = request.params?.name || '';
            if (name === 'fail2') {
                return { content: [{ type: 'text', text: 'http boom' }], isError: true };
            }
            return { content: [{ type: 'text', text: `http:${name}` }] };
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${httpServer.address().port}/mcp`,
        close: () => new Promise((resolve) => httpServer.close(resolve))
    };
}

test('McpClientManager 通过 stdio 连接真实 MCP 服务器并调用工具', async () => {
    const config = { mcp: { client: { enabled: true, maxResultChars: 4000, servers: [stdioServer()] } } };
    const manager = new McpClientManager({ config, logger: silentLogger });
    try {
        await manager.reload();
        const status = manager.getStatus();
        assert.equal(status.enabled, true);
        assert.equal(status.servers.length, 1);
        assert.equal(status.servers[0].state, 'connected');
        assert.equal(status.servers[0].toolCount, 5);
        assert.deepEqual(
            status.servers[0].tools.map((tool) => tool.name).sort(),
            ['add', 'big', 'echo', 'env_check', 'fail']
        );

        const definitions = manager.getToolDefinitions();
        assert.deepEqual(definitions.map((item) => item.name).sort(), [
            'mcp__echo-server__add',
            'mcp__echo-server__big',
            'mcp__echo-server__echo',
            'mcp__echo-server__env_check',
            'mcp__echo-server__fail'
        ]);
        const echoDefinition = definitions.find((item) => item.toolName === 'echo');
        assert.equal(echoDefinition.definition.type, 'function');
        assert.equal(echoDefinition.definition.function.parameters.type, 'object');
        assert.deepEqual(echoDefinition.definition.function.parameters.required, ['text']);

        const echo = await manager.callTool({ serverId: 'test-stdio', tool: 'echo', arguments: { text: 'hi' } });
        assert.equal(echo.ok, true);
        assert.equal(echo.text, 'echo:hi');

        const add = await manager.callTool({ serverId: 'test-stdio', tool: 'add', arguments: { a: 2, b: 3 } });
        assert.equal(add.text, '5');

        const failed = await manager.callTool({ serverId: 'test-stdio', tool: 'fail' });
        assert.equal(failed.ok, false);
        assert.equal(failed.error, 'boom');

        const big = await manager.callTool({ serverId: 'test-stdio', tool: 'big' });
        assert.equal(big.ok, true);
        assert.equal(big.truncated, true);
        assert.match(big.text, /结果已截断/);

        const env = await manager.callTool({ serverId: 'test-stdio', tool: 'env_check', arguments: { key: 'TEST_KEY' } });
        assert.equal(env.text, 'hello-env');

        const missingTool = await manager.callTool({ serverId: 'test-stdio', tool: 'nope' });
        assert.equal(missingTool.ok, false);
        assert.match(missingTool.error, /没有工具/);

        const missingServer = await manager.callTool({ serverId: 'nope', tool: 'echo' });
        assert.equal(missingServer.ok, false);
        assert.match(missingServer.error, /服务器不存在/);
    } finally {
        await manager.close();
    }
});

test('McpClientManager 工具过滤与命名空间裁剪生效', async () => {
    const config = {
        mcp: {
            client: {
                enabled: true,
                servers: [stdioServer({ toolFilter: { include: ['echo', 'add'], exclude: ['add'] } })]
            }
        }
    };
    const manager = new McpClientManager({ config, logger: silentLogger });
    try {
        await manager.reload();
        const definitions = manager.getToolDefinitions();
        assert.deepEqual(definitions.map((item) => item.name), ['mcp__echo-server__echo']);

        (await manager.close());
    } finally {
        await manager.close();
    }
});

test('McpClientManager 客户端关闭时不注册工具', async () => {
    const config = { mcp: { client: { enabled: false, servers: [stdioServer()] } } };
    const manager = new McpClientManager({ config, logger: silentLogger });
    try {
        await manager.reload();
        const status = manager.getStatus();
        assert.equal(status.enabled, false);
        assert.equal(status.servers[0].state, 'disabled');
        assert.deepEqual(manager.getToolDefinitions(), []);
    } finally {
        await manager.close();
    }
});

test('McpClientManager 连接失败时进入错误状态并给出原因', async () => {
    const config = {
        mcp: {
            client: {
                enabled: true,
                servers: [stdioServer({ id: 'broken', name: 'broken-server', command: 'definitely-not-a-real-command-xyz' })]
            }
        }
    };
    const manager = new McpClientManager({ config, logger: silentLogger });
    try {
        await manager.reload();
        const status = manager.getStatus();
        assert.equal(status.servers[0].state, 'error');
        assert.ok(status.servers[0].lastError);
        assert.deepEqual(manager.getToolDefinitions(), []);

        const reconnect = await manager.reconnect('broken');
        assert.equal(reconnect.ok, false);
        assert.equal(reconnect.state, 'error');
    } finally {
        await manager.close();
    }
});

test('McpClientManager 通过 streamable-http 连接并调用工具', async () => {
    const httpServer = await createHttpMcpServer();
    const config = {
        mcp: {
            client: {
                enabled: true,
                servers: [{
                    id: 'http-1',
                    name: 'http-server',
                    enabled: true,
                    transport: 'http',
                    url: httpServer.url,
                    headers: { 'X-Test': 'yes' },
                    timeoutMs: 10000
                }]
            }
        }
    };
    const manager = new McpClientManager({ config, logger: silentLogger });
    try {
        await manager.reload();
        const status = manager.getStatus();
        assert.equal(status.servers[0].state, 'connected');
        assert.equal(status.servers[0].toolCount, 2);

        const call = await manager.callTool({ serverId: 'http-1', tool: 'ping2' });
        assert.equal(call.ok, true);
        assert.equal(call.text, 'http:ping2');

        const failed = await manager.callTool({ serverId: 'http-1', tool: 'fail2' });
        assert.equal(failed.ok, false);
        assert.equal(failed.error, 'http boom');
    } finally {
        await manager.close();
        await httpServer.close();
    }
});

test('MCP 配置归一化、掩码与密钥合并', () => {
    const normalized = normalizeMcpClientConfig({
        enabled: true,
        maxResultChars: 999999,
        servers: [
            { name: 'a', transport: 'weird', command: 'npx', env: { TOKEN: 'secret' }, timeoutMs: 10 },
            { name: '' }
        ]
    });
    assert.equal(normalized.maxResultChars, 50000);
    assert.equal(normalized.servers.length, 1);
    assert.equal(normalized.servers[0].transport, 'stdio');
    assert.equal(normalized.servers[0].timeoutMs, 1000);
    assert.equal(normalized.servers[0].toolFilter.include.length, 0);

    const masked = maskMcpServerForClient({ name: 'a', env: { TOKEN: 'secret', EMPTY: '' }, headers: { Auth: 'x' } });
    assert.equal(masked.env.TOKEN, '******');
    assert.equal(masked.env.EMPTY, '');
    assert.equal(masked.headers.Auth, '******');
    assert.equal(masked.hasEnv, true);
    assert.equal(masked.hasHeaders, true);
    assert.ok(!JSON.stringify(masked).includes('secret'));

    const merged = mergeMcpSecrets({ TOKEN: '******', NEW: 'n' }, { TOKEN: 'old', DROP: 'x' });
    assert.deepEqual(merged, { TOKEN: 'old', NEW: 'n' });
});
