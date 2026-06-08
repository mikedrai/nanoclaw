/**
 * Enorasi → nanoclaw HTTP bridge.
 *
 * Runs on the nanoclaw HOST (which has pnpm/tsx, the provision/manage scripts,
 * and data/cli.sock). The Enorasi website — which runs in a slim Docker
 * container and therefore can't exec these scripts or reach the 0600 socket —
 * calls this bridge over HTTP instead, behind the same AgentRuntime interface.
 *
 * Security: every request needs `Authorization: Bearer $BRIDGE_TOKEN`. Bind it
 * to the host only and firewall the port to the Docker subnet (it must never be
 * publicly reachable). Start it from the nanoclaw root:
 *
 *   BRIDGE_TOKEN=<secret> BRIDGE_PORT=10260 pnpm exec tsx scripts/enorasi-bridge.ts
 *
 * Endpoints (all POST + JSON unless noted):
 *   GET  /health                                            -> { ok }
 *   POST /provision   {displayName,agentName,folder,kbPath?,instructions,mcpConfig,provider?,model?}
 *                                                           -> {agentGroupId,cliPlatformId,pairingCode,deepLink}
 *   POST /reconfigure {agentGroupId,folder,assistantName,instructions,mcpConfig,provider?,model?}
 *   POST /stop|/start|/destroy {agentGroupId,folder?}
 *   POST /chat        {text,to?}                            -> {reply}
 */
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd(); // launched from the nanoclaw root (/opt/nanoclaw)
const SOCK = join(ROOT, 'data', 'cli.sock');

/**
 * Cap one agent's daily LLM requests at the OneCLI proxy — the real per-student
 * spend ceiling (applies on EVERY channel, web + Telegram). Best-effort: never
 * blocks provisioning. Scopes a rate_limit rule on api.anthropic.com to this agent.
 */
async function applyDailyLlmCap(agentGroupId: string, agentName: string, cap: number): Promise<void> {
  const ONECLI = envVar('ONECLI_BIN') || join(process.env.HOME || '/home/deploy', '.local', 'bin', 'onecli');
  const { stdout } = await execFileAsync(ONECLI, ['agents', 'list']);
  const agents = (JSON.parse(stdout).data ?? []) as Array<{ id: string; name: string; identifier: string }>;
  let found = agents.find((a) => a.identifier === agentGroupId) || agents.find((a) => a.name === agentName);
  if (!found) {
    // OneCLI registers an agent lazily on its first run; pre-create it here so the
    // cap applies from the very first message. nanoclaw's `onecli run` reuses it by identifier.
    const created = JSON.parse((await execFileAsync(ONECLI, ['agents', 'create', '--name', agentName, '--identifier', agentGroupId])).stdout);
    found = { id: created.id, name: created.name, identifier: created.identifier };
  }
  const agent = found;
  const rules = (JSON.parse((await execFileAsync(ONECLI, ['rules', 'list'])).stdout).data ?? []) as Array<{ agentId: string; hostPattern: string; action: string }>;
  if (rules.some((r) => r.agentId === agent.id && r.hostPattern === 'api.anthropic.com' && r.action === 'rate_limit')) {
    console.log(`[enorasi-bridge] daily LLM cap already present for ${agent.name} (${agent.id})`);
    return;
  }
  await execFileAsync(ONECLI, ['rules', 'create',
    '--name', `daily-llm-cap-${cap}`,
    '--host-pattern', 'api.anthropic.com',
    '--action', 'rate_limit',
    '--rate-limit', String(cap),
    '--rate-limit-window', 'day',
    '--agent-id', agent.id,
    '--enabled']);
  console.log(`[enorasi-bridge] daily LLM cap ${cap}/day set for ${agent.name} (${agent.id})`);
}

function envVar(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

const TOKEN = envVar('BRIDGE_TOKEN');
const PORT = parseInt(envVar('BRIDGE_PORT') || '10260', 10);
// Bind to the docker bridge gateway (host.docker.internal → 172.17.0.1 from the
// web container) rather than 0.0.0.0, so the listen socket is unreachable from
// the public NIC regardless of UFW state. Override with BRIDGE_BIND if needed.
const BIND = envVar('BRIDGE_BIND') || '172.17.0.1';
if (!TOKEN) {
  console.error('[enorasi-bridge] BRIDGE_TOKEN is required');
  process.exit(1);
}

/** Constant-time bearer check (avoids a token-length/byte timing oracle). */
function authOk(header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tmpFile(content: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'enorasi-bridge-'));
  const f = join(dir, name);
  writeFileSync(f, content);
  return f;
}

async function runScript(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', script, ...args], {
    cwd: ROOT,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

type ChatRoute = { channelType: string; platformId: string; threadId: string | null };

/** Relay one message to the agent over cli.sock (mirrors the website's askAgent). */
function askAgent(text: string, to: ChatRoute | undefined, silenceMs = 2500, totalMs = 150_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCK);
    const parts: string[] = [];
    let buffer = '';
    let firstReply = false;
    let silenceTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      socket.removeAllListeners();
      socket.destroy();
    };
    const finish = () => {
      cleanup();
      resolve(parts.join('\n').trim());
    };
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const schedule = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, silenceMs);
    };
    socket.on('connect', () => {
      socket.write(JSON.stringify(to ? { text, to } : { text }) + '\n');
      hardTimer = setTimeout(() => (firstReply ? finish() : fail(new Error('Agent did not reply in time.'))), totalMs);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { text?: string };
          if (typeof msg.text === 'string') {
            parts.push(msg.text);
            firstReply = true;
            schedule();
          }
        } catch {
          /* ignore non-JSON noise */
        }
      }
    });
    socket.on('error', (e) => fail(new Error(`Cannot reach the agent runtime (${e.message}).`)));
    socket.on('close', () => firstReply && finish());
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 8_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => {
    console.log(`[enorasi-bridge] ${req.method} ${req.url} -> ${code}`);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = req.url || '';
    if (req.method === 'GET' && url === '/health') return send(200, { ok: true });
    if (!authOk(req.headers.authorization)) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return send(404, { error: 'not found' });

    const b = await readBody(req);
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);

    if (url === '/provision') {
      const instr = tmpFile((s('instructions') ?? ''), 'CLAUDE.local.md');
      const mcp = tmpFile(JSON.stringify(b.mcpConfig ?? {}), 'mcp.json');
      const args = ['--display-name', s('displayName')!, '--agent-name', s('agentName')!, '--folder', s('folder')!, '--instructions-file', instr, '--mcp-file', mcp, '--json'];
      if (s('kbPath')) args.push('--kb-path', s('kbPath')!);
      if (s('provider')) args.push('--provider', s('provider')!);
      if (s('model')) args.push('--model', s('model')!);
      const out = await runScript('scripts/provision-student.ts', args);
      const last = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
      const result = JSON.parse(last);
      try {
        const cap = parseInt((typeof b.dailyRequestCap === 'number' ? String(b.dailyRequestCap) : s('dailyRequestCap')) || '100', 10);
        if (result.agentGroupId && cap > 0) await applyDailyLlmCap(result.agentGroupId, s('agentName')!, cap);
      } catch (e) {
        console.error('[enorasi-bridge] daily LLM cap failed:', e instanceof Error ? e.message : e);
      }
      return send(200, result);
    }
    if (url === '/provision-admin-agent') {
      const out = await runScript('scripts/provision-taso.mts', []);
      const last = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
      let result: { agentGroupId?: string } = {};
      try { result = JSON.parse(last); } catch { /* recipe printed non-JSON */ }
      // bounce Taso's container so it respawns with the converged config (nanoclaw
      // re-reads container_configs on each spawn — no full restart needed).
      try { await execFileAsync('bash', ['-c', 'docker stop $(docker ps -q --filter name=nanoclaw-v2-taso) 2>/dev/null || true']); } catch (e) { console.error('[enorasi-bridge] taso bounce failed:', e instanceof Error ? e.message : e); }
      return send(200, { ok: true, agentGroupId: result.agentGroupId });
    }

    if (url === '/reconfigure') {
      const instr = tmpFile((s('instructions') ?? ''), 'CLAUDE.local.md');
      const mcp = tmpFile(JSON.stringify(b.mcpConfig ?? {}), 'mcp.json');
      const args = ['--action', 'reconfigure', '--agent-group-id', s('agentGroupId')!, '--folder', s('folder')!, '--assistant-name', s('assistantName')!, '--instructions-file', instr, '--mcp-file', mcp];
      if (s('provider')) args.push('--provider', s('provider')!);
      if (s('model')) args.push('--model', s('model')!);
      await runScript('scripts/manage-student.ts', args);
      try {
        const cap = parseInt((typeof b.dailyRequestCap === 'number' ? String(b.dailyRequestCap) : s('dailyRequestCap')) || '100', 10);
        if (cap > 0) await applyDailyLlmCap(s('agentGroupId')!, s('assistantName')!, cap);
      } catch (e) {
        console.error('[enorasi-bridge] reconfigure cap failed:', e instanceof Error ? e.message : e);
      }
      return send(200, { ok: true });
    }
    if (url === '/stop' || url === '/start' || url === '/destroy') {
      const action = url === '/destroy' ? 'delete' : url.slice(1);
      const args = ['--action', action, '--agent-group-id', s('agentGroupId')!];
      if (s('folder')) args.push('--folder', s('folder')!);
      await runScript('scripts/manage-student.ts', args);
      return send(200, { ok: true });
    }
    if (url === '/chat') {
      const reply = await askAgent(s('text') ?? '', b.to as ChatRoute | undefined);
      // Best-effort: surface the daily LLM cap (OneCLI returns 429 to the agent) to the website.
      if (/\b429\b|rate.?limit|too many requests|quota (exceeded|reached)|daily limit reached/i.test(reply)) {
        return send(429, { error: 'daily LLM limit reached', code: 'rate_limited' });
      }
      return send(200, { reply });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    console.error(`[enorasi-bridge] ${req.method} ${req.url} ERROR:`, e instanceof Error ? e.message : e);
    return send(500, { error: e instanceof Error ? e.message : 'bridge error' });
  }
});

server.listen(PORT, BIND, () => console.log(`[enorasi-bridge] listening on ${BIND}:${PORT}`));
