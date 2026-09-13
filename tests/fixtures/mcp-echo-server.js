#!/usr/bin/env node
/**
 * 测试用 MCP stdio 服务器（低层 Server API，不依赖 zod）
 * 工具：echo / add / fail / big / env_check
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
    { name: 'mimir-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'echo',
            description: '回显文本',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        },
        {
            name: 'add',
            description: '两数相加',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
        },
        {
            name: 'fail',
            description: '总是返回错误',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'big',
            description: '返回大文本',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'env_check',
            description: '读取环境变量（测试 env 注入）',
            inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params || {};
    if (name === 'echo') {
        return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] };
    }
    if (name === 'add') {
        return { content: [{ type: 'text', text: String(Number(args.a || 0) + Number(args.b || 0)) }] };
    }
    if (name === 'fail') {
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
    }
    if (name === 'big') {
        return { content: [{ type: 'text', text: 'x'.repeat(6000) }] };
    }
    if (name === 'env_check') {
        return { content: [{ type: 'text', text: String(process.env[String(args.key)] ?? '<unset>') }] };
    }
    throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
