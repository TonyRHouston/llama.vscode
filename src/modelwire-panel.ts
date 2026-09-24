// "modelwire" control panel: monitors and operates a modelwire bridge (github.com/TonyRHouston/modelwire)
// from the llama.vscode sidebar, and points llama.vscode's endpoints at one of its aliases.
//
// Security notes (see modelwire docs/LLAMA-VSCODE.md): the URL setting is machine-scoped so a workspace
// cannot redirect the panel; the control key lives in SecretStorage; the webview has a strict CSP and
// renders every value with textContent; every webview message is validated before it reaches the API.
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

const KEY_SECRET = 'llama-vscode.modelwire.controlKey';
const ALIAS = /^[\w.:@-]{1,80}$/;
const UNIT = /^[\w@.-]{1,120}\.service$/;
const HOST = /^[\w-]{1,40}$/;
const ACTIONS = new Set(['start', 'stop', 'restart']);

type Json = any;

export class ModelwirePanel implements vscode.WebviewViewProvider {
    public static readonly viewId = 'llama-vscode.modelwire';
    private view?: vscode.WebviewView;
    private timer?: NodeJS.Timeout;
    private hostsTimer?: NodeJS.Timeout;

    constructor(private readonly context: vscode.ExtensionContext) {}

    static register(context: vscode.ExtensionContext): ModelwirePanel {
        const panel = new ModelwirePanel(context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(ModelwirePanel.viewId, panel),
            vscode.commands.registerCommand('llama-vscode.modelwire.setControlKey', () => panel.setControlKey()),
            vscode.commands.registerCommand('llama-vscode.modelwire.refresh', () => panel.refresh(true)),
            vscode.commands.registerCommand('llama-vscode.modelwire.useAlias', (alias?: string) => panel.useAlias(alias)),
        );
        return panel;
    }

    private baseUrl(): string {
        const url = vscode.workspace.getConfiguration('llama-vscode').inspect<string>('modelwire_url');
        // Only user/default values: a workspace must not be able to point the panel elsewhere.
        return String(url?.globalValue ?? url?.defaultValue ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
    }

    private async api(method: 'GET' | 'POST', path: string, body?: Json, timeoutMs = 15000): Promise<Json> {
        const key = await this.context.secrets.get(KEY_SECRET);
        if (!key) throw new Error('No control key. Run "modelwire: Set Control Key" (get it with `mw control-key` on the modelwire host).');
        const res = await fetch(`${this.baseUrl()}/v1/control${path}`, {
            method,
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
        return data;
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((m) => this.onMessage(m));
        view.onDidChangeVisibility(() => this.schedule());
        view.onDidDispose(() => { clearInterval(this.timer); clearInterval(this.hostsTimer); this.view = undefined; });
        this.schedule();
    }

    private schedule(): void {
        clearInterval(this.timer); clearInterval(this.hostsTimer);
        if (!this.view?.visible) return;
        this.refresh(true);
        this.timer = setInterval(() => this.refresh(false), 5000);
        this.hostsTimer = setInterval(() => this.refreshHosts(), 30000);
    }

    private post(message: Json): void { this.view?.webview.postMessage(message); }

    async refresh(withHosts: boolean): Promise<void> {
        try { this.post({ type: 'status', url: this.baseUrl(), status: await this.api('GET', '/status') }); }
        catch (error) { this.post({ type: 'error', url: this.baseUrl(), message: String((error as Error).message) }); }
        if (withHosts) await this.refreshHosts();
    }

    private async refreshHosts(): Promise<void> {
        try { this.post({ type: 'hosts', hosts: (await this.api('GET', '/hosts', undefined, 45000)).hosts }); }
        catch (error) { this.post({ type: 'hostsError', message: String((error as Error).message) }); }
    }

    private async setControlKey(): Promise<void> {
        const key = await vscode.window.showInputBox({ prompt: 'modelwire control key (`mw control-key` prints it)', password: true, ignoreFocusOut: true });
        if (key === undefined) return;
        if (key.trim()) await this.context.secrets.store(KEY_SECRET, key.trim()); else await this.context.secrets.delete(KEY_SECRET);
        this.refresh(true);
    }

    // Points all four llama.vscode endpoints at one modelwire alias (user settings) and keeps the
    // agent's auto-approvals off.
    async useAlias(alias?: string): Promise<void> {
        if (!alias || !ALIAS.test(alias)) return;
        const endpoint = `${this.baseUrl()}/m/${encodeURIComponent(alias)}`;
        const settings: Record<string, unknown> = {
            endpoint, endpoint_chat: endpoint, endpoint_tools: endpoint, endpoint_embeddings: endpoint,
            ai_api_version: 'v1', use_openai_endpoint: false,
            tool_permit_some_terminal_commands: false, tool_permit_file_changes: false, tool_permit_file_delete: false,
            tool_custom_eval_tool_enabled: false, telegram_bot_enabled: false,
        };
        const ok = await vscode.window.showInformationMessage(
            `Point llama.vscode at modelwire alias "${alias}"?`,
            { modal: true, detail: `Completion, chat, tools and embeddings -> ${endpoint}\nAgent auto-approvals, custom eval tool and Telegram are switched off. (User settings.)` },
            'Apply');
        if (ok !== 'Apply') return;
        const config = vscode.workspace.getConfiguration('llama-vscode');
        for (const [key, value] of Object.entries(settings)) await config.update(key, value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`llama.vscode now uses modelwire alias "${alias}".`);
    }

    private async onMessage(m: Json): Promise<void> {
        try {
            switch (m?.type) {
                case 'refresh': return this.refresh(true);
                case 'setKey': return this.setControlKey();
                case 'warmup': await this.api('POST', '/warmup', {}, 330000); return this.refresh(false);
                case 'refreshMetadata': await this.api('POST', '/metadata/refresh', {}, 60000); return this.refresh(false);
                case 'useAlias': return this.useAlias(String(m.alias ?? ''));
                case 'setCompletions': {
                    const order = Array.isArray(m.order) ? m.order.map(String) : [];
                    if (!ALIAS.test(String(m.alias)) || !order.length || !order.every((a: string) => ALIAS.test(a))) return;
                    await this.api('POST', '/completions', { alias: m.alias, order });
                    return this.refresh(false);
                }
                case 'restartModelwire': {
                    const ok = await vscode.window.showWarningMessage('Restart modelwire? In-flight requests are cancelled.', { modal: true }, 'Restart');
                    if (ok !== 'Restart') return;
                    await this.api('POST', '/restart', {});
                    setTimeout(() => this.refresh(true), 4000);
                    return;
                }
                case 'hostAction': {
                    const { host, unit, action } = m;
                    if (!HOST.test(String(host)) || !UNIT.test(String(unit)) || !ACTIONS.has(String(action))) return;
                    if (action !== 'start') {
                        const ok = await vscode.window.showWarningMessage(`${action} ${unit} on ${host}?`, { modal: true }, action === 'stop' ? 'Stop' : 'Restart');
                        if (!ok) return;
                    }
                    const r = await this.api('POST', `/hosts/${host}/${unit}/${action}`, {}, 60000);
                    vscode.window.showInformationMessage(`${host}: ${unit} is ${r.state}`);
                    return this.refreshHosts();
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`modelwire: ${(error as Error).message}`);
        }
    }

    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 8px 12px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 14px 0 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 8px; border-radius: 2px; cursor: pointer; font-size: 12px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { filter: brightness(1.15); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .ok { color: var(--vscode-testing-iconPassed); } .bad { color: var(--vscode-errorForeground); } .warn { color: var(--vscode-editorWarning-foreground); }
  .pill { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); }
  .meter { height: 4px; background: var(--vscode-panel-border); border-radius: 2px; margin-top: 2px; } .meter > div { height: 4px; border-radius: 2px; background: var(--vscode-progressBar-background); }
  table { width: 100%; border-collapse: collapse; font-size: 11px; } td { padding: 2px 3px; border-top: 1px solid var(--vscode-panel-border); }
  .error { color: var(--vscode-errorForeground); margin: 8px 0; }
</style></head>
<body>
  <div class="row"><strong>modelwire</strong><span id="url" class="muted"></span></div>
  <div id="summary" class="muted"></div>
  <div class="bar">
    <button data-act="refresh">Refresh</button><button data-act="warmup">Re-warm</button>
    <button data-act="refreshMetadata">Refresh metadata</button><button data-act="restartModelwire">Restart modelwire</button>
    <button data-act="setKey">Control key</button>
  </div>
  <div id="error" class="error"></div>
  <h3>Aliases</h3><div id="aliases"></div>
  <h3>Hosts</h3><div id="hosts" class="muted">loading…</div>
  <h3>Recent requests</h3><div id="ledger"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c))); return n; };
  const send = (m) => vscode.postMessage(m);
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => send({ type: b.dataset.act })));
  // Width via the CSSOM: the CSP blocks style attributes.
  const meter = (fraction) => { const fill = el('div'); fill.style.width = Math.min(100, Math.round(100 * fraction)) + '%'; return el('div', { class: 'meter' }, fill); };
  const fmtUp = (s) => s > 86400 ? Math.floor(s / 86400) + 'd' : s > 3600 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 60) + 'm';

  function renderStatus(url, st) {
    $('url').textContent = url; $('error').textContent = '';
    $('summary').textContent = 'up ' + fmtUp(st.server.uptimeS) + ' · ' + st.server.requests + ' requests · ' + st.server.responseCacheHits + ' cache hits';
    const byName = Object.fromEntries(st.aliases.map((a) => [a.alias, a]));
    const cards = st.aliases.map((a) => {
      const q = st.queues[a.apiBase];
      const state = !a.available ? el('span', { class: 'bad' }, '● down') : a.drift.length ? el('span', { class: 'warn', title: a.drift.join('; ') }, '● drift') : el('span', { class: 'ok' }, '● up');
      const head = el('div', { class: 'row' }, el('span', {}, el('strong', {}, a.alias), ' ', el('span', { class: 'pill' }, a.kind)), state);
      const meta = el('div', { class: 'muted' }, [a.host, a.model, a.contextWindow ? 'ctx ' + a.contextWindow : null, q ? 'queue ' + q.active + '/' + a.maxConcurrent + (q.waiting ? ' +' + q.waiting + ' waiting' : '') : null].filter(Boolean).join(' · '));
      const card = el('div', { class: 'card' }, head, meta);
      if (a.kind === 'chat') {
        if (a.completions) {
          const order = [...a.completions];
          const line = el('div', { class: 'muted' }, 'completions: ');
          order.forEach((c, i) => {
            const up = byName[c]?.available;
            line.append(el('span', { class: up ? 'ok' : 'bad' }, c));
            if (i < order.length - 1) line.append(el('button', { title: 'swap', onclick: () => { const o = [...order]; [o[i], o[i + 1]] = [o[i + 1], o[i]]; send({ type: 'setCompletions', alias: a.alias, order: o }); } }, '⇄'));
          });
          card.append(line);
        }
        if (a.embeddings) card.append(el('div', { class: 'muted' }, 'embeddings: ' + a.embeddings.join(' → ')));
        card.append(el('div', { class: 'bar' }, el('button', { class: 'primary', onclick: () => send({ type: 'useAlias', alias: a.alias }) }, 'Use in llama.vscode')));
      }
      return card;
    });
    $('aliases').replaceChildren(...cards);
    const rows = st.ledger.slice(0, 15).map((r) => el('tr', {}, el('td', {}, (r.at || '').slice(11, 19)), el('td', {}, r.alias), el('td', {}, r.api),
      el('td', {}, r.cached ? 'cached' : r.error ? el('span', { class: 'bad', title: r.error }, 'error') : (r.ms / 1000).toFixed(1) + 's'),
      el('td', {}, r.inputTokens != null ? r.inputTokens + '→' + r.outputTokens + (r.cacheN ? ' (' + r.cacheN + ' cached)' : '') : '')));
    $('ledger').replaceChildren(rows.length ? el('table', {}, rows) : el('div', { class: 'muted' }, 'no requests today'));
  }

  function renderHosts(hosts) {
    $('hosts').className = '';
    $('hosts').replaceChildren(...hosts.map((h) => {
      const card = el('div', { class: 'card' }, el('div', { class: 'row' }, el('strong', {}, h.host), el('span', { class: h.reachable ? 'ok' : 'bad' }, h.reachable ? '● reachable' : '● unreachable')), el('div', { class: 'muted' }, h.description));
      for (const g of h.gpus) card.append(el('div', { class: 'muted' }, g.name + ' · ' + (g.usedMiB / 1024).toFixed(1) + ' / ' + (g.totalMiB / 1024).toFixed(1) + ' GB'), meter(g.usedMiB / g.totalMiB));
      for (const [unit, state] of Object.entries(h.units)) {
        const act = (action) => el('button', { onclick: () => send({ type: 'hostAction', host: h.host, unit, action }) }, action);
        card.append(el('div', { class: 'row' }, el('span', {}, el('span', { class: state === 'active' ? 'ok' : 'bad' }, '● '), unit), el('span', {}, state === 'active' ? [act('restart'), act('stop')] : act('start'))));
      }
      return card;
    }));
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'status') renderStatus(m.url, m.status);
    else if (m.type === 'error') { $('url').textContent = m.url; $('error').textContent = m.message; }
    else if (m.type === 'hosts') renderHosts(m.hosts);
    else if (m.type === 'hostsError') { $('hosts').className = 'error'; $('hosts').textContent = m.message; }
  });
</script></body></html>`;
    }
}
