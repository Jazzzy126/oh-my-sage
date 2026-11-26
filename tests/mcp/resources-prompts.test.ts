import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server';

test('MCP Server 注册并提供完整的自动化指南 Resources 与工作流 Prompts，且保持 32 个工具契约', async () => {
    const server = createServer({ gatewayUrl: 'http://192.0.2.1' });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);

    try {
        const tools = await client.listTools();
        assert.equal(tools.tools.length, 32, 'MCP 工具总数应保持 32 个');

        const resources = await client.listResources();
        const uris = resources.resources.map(r => r.uri);
        assert.equal(uris.includes('mijia://guides/automation-skill'), true);
        assert.equal(uris.includes('mijia://guides/rule-text-format'), true);
        assert.equal(uris.includes('mijia://guides/complete-reference'), true);
        assert.equal(uris.includes('mijia://guides/patterns-index'), true);

        const skillDoc = await client.readResource({ uri: 'mijia://guides/automation-skill' });
        const firstContent = skillDoc.contents[0] as { text?: string };
        assert.ok(firstContent.text && firstContent.text.includes('米家自动化规则创建'));

        const prompts = await client.listPrompts();
        const promptNames = prompts.prompts.map(p => p.name);
        assert.deepEqual(promptNames.sort(), ['create-automation', 'diagnose-rule', 'modify-rule']);

        const rendered = await client.getPrompt({
            name: 'create-automation',
            arguments: { requirement: '有人开灯，无人5分钟关灯' },
        });
        const promptText = (rendered.messages[0]?.content as { text?: string })?.text || '';
        assert.ok(promptText.includes('有人开灯，无人5分钟关灯'));
        assert.ok(promptText.includes('mijia_create_graph'));
    } finally {
        await client.close();
        await server.close();
    }
});
