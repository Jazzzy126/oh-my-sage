import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {testModelConnection} from '../../src/server/ai/model';

async function withMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    fn: (baseURL: string) => Promise<void>
): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
        server.close();
        throw new Error('Unexpected server address');
    }
    const baseURL = `http://127.0.0.1:${addr.port}/v1`;
    try {
        await fn(baseURL);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

describe('testModelConnection', () => {
    it('returns failure when required config fields are missing', async () => {
        const res = await testModelConnection({
            baseURL: '',
            apiKey: 'sk-test',
            model: 'gpt-4o',
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? '', /API Base URL/);
    });

    it('succeeds against an OpenAI-compatible chat/completions endpoint', async () => {
        let receivedAuth = '';
        await withMockServer((req, res) => {
            receivedAuth = req.headers.authorization ?? '';
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'gpt-4o',
                choices: [
                    {
                        index: 0,
                        message: {role: 'assistant', content: 'OK'},
                        finish_reason: 'stop',
                    },
                ],
                usage: {prompt_tokens: 4, completion_tokens: 1, total_tokens: 5},
            }));
        }, async (baseURL) => {
            const res = await testModelConnection({
                baseURL,
                apiKey: 'sk-test-123',
                model: 'gpt-4o',
            });
            assert.equal(res.success, true);
            assert.equal(res.model, 'gpt-4o');
            assert.ok(res.latencyMs >= 0);
            assert.equal(receivedAuth, 'Bearer sk-test-123');
        });
    });

    it('returns failure with error message on HTTP 401', async () => {
        await withMockServer((_req, res) => {
            res.writeHead(401, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                error: {message: 'Invalid API key', type: 'invalid_request_error'},
            }));
        }, async (baseURL) => {
            const res = await testModelConnection({
                baseURL,
                apiKey: 'sk-bad',
                model: 'gpt-4o',
            });
            assert.equal(res.success, false);
            assert.ok(res.error && res.error.length > 0);
        });
    });
});
