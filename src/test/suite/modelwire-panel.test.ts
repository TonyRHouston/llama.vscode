/// <reference types="mocha" />
import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { suite, test, suiteSetup, suiteTeardown } from 'mocha';
import { ModelwirePanel } from '../../modelwire-panel';

// A fake modelwire control API and a fake extension context (secrets only).
suite('modelwire panel', () => {
    let server: http.Server;
    let url = '';
    const seen: { method: string; path: string; auth: string }[] = [];
    const secrets = new Map<string, string>();
    const context = { secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => { secrets.set(k, v); }, delete: async (k: string) => { secrets.delete(k); } }, subscriptions: [] } as any;

    suiteSetup(async () => {
        server = http.createServer((req, res) => {
            seen.push({ method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? '') });
            res.setHeader('content-type', 'application/json');
            if (req.headers.authorization !== 'Bearer test-key') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'control key required' } })); }
            res.end(JSON.stringify({ server: { uptimeS: 60, requests: 3, responseCacheHits: 1 }, queues: {}, aliases: [{ alias: 'gpt-oss:120b', kind: 'chat', available: true, drift: [], completions: ['mace-coder'] }], ledger: [] }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        url = `http://127.0.0.1:${(server.address() as any).port}`;
        await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_url', url, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_control_key_file', '/nonexistent/control.key', vscode.ConfigurationTarget.Global);
    });
    suiteTeardown(async () => {
        server.close();
        await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_url', undefined, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_control_key_file', undefined, vscode.ConfigurationTarget.Global);
    });

    const attach = (panel: ModelwirePanel) => {
        const posted: any[] = [];
        (panel as any).view = { webview: { postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); } } };
        return posted;
    };

    test('the webview has a nonce CSP and no inline style attributes or event handlers', () => {
        const html: string = (new ModelwirePanel(context) as any).html({ cspSource: 'vscode-webview:' });
        assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src vscode-webview: 'nonce-[^']+'; script-src 'nonce-[^']+';/);
        assert.doesNotMatch(html, / style="/);
        assert.doesNotMatch(html, / on[a-z]+="/);
        assert.doesNotMatch(html, /innerHTML/);
    });

    test('modelwire_url is machine-scoped (workspace settings cannot redirect the panel)', () => {
        const ext = vscode.extensions.getExtension('ggml-org.llama-vscode');
        const props = Object.assign({}, ...[].concat(ext!.packageJSON.contributes.configuration).map((c: any) => c.properties));
        assert.strictEqual(props['llama-vscode.modelwire_url'].scope, 'machine');
    });

    test('refresh fetches status with the stored control key and forwards it to the webview', async () => {
        secrets.set('llama-vscode.modelwire.controlKey', 'test-key');
        const panel = new ModelwirePanel(context);
        const posted = attach(panel);
        await panel.refresh(false);
        assert.strictEqual(posted[0].type, 'status', JSON.stringify(posted[0]));
        assert.strictEqual(posted[0].url, url);
        assert.strictEqual(posted[0].status.aliases[0].alias, 'gpt-oss:120b');
        assert.deepStrictEqual(seen.at(-1), { method: 'GET', path: '/v1/control/status', auth: 'Bearer test-key' });
    });

    test('with no stored key the panel falls back to the key file', async () => {
        secrets.clear();
        const file = path.join(os.tmpdir(), `mw-key-${process.pid}`);
        fs.writeFileSync(file, 'test-key\n');
        await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_control_key_file', file, vscode.ConfigurationTarget.Global);
        try {
            const panel = new ModelwirePanel(context);
            const posted = attach(panel);
            await panel.refresh(false);
            assert.strictEqual(posted[0].type, 'status', JSON.stringify(posted[0]));
        } finally {
            await vscode.workspace.getConfiguration('llama-vscode').update('modelwire_control_key_file', '/nonexistent/control.key', vscode.ConfigurationTarget.Global);
            fs.unlinkSync(file);
        }
    });

    test('without a control key the panel explains how to get one and sends nothing', async () => {
        secrets.clear();
        const before = seen.length;
        const panel = new ModelwirePanel(context);
        const posted = attach(panel);
        await panel.refresh(false);
        assert.strictEqual(posted[0].type, 'error');
        assert.match(posted[0].message, /mw control-key/);
        assert.strictEqual(seen.length, before);
    });
});
