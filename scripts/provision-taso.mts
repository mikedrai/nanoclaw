/**
 * Idempotent provisioning for Taso, the Enorasi admin agent. Single source of
 * truth for Taso's full capability set so delete + re-run restores it.
 * Safe on a LIVE Taso: if the group exists, only the capability layer is
 * converged (no re-pairing); if missing, the base agent is created first.
 *   Run: pnpm exec tsx scripts/provision-taso.mts
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const HOME = homedir();
const NC = '/opt/nanoclaw';
const DBF = NC + '/data/v2.db';
const NAME = 'Taso';
const FOLDER = 'taso';
const MODEL = 'claude-haiku-4-5'; // fast model — Taso's work is structured (DB/admin/calendar); Haiku is 2-3x quicker than Sonnet here
const KB = '/data/kb/taso';
const INSTR = NC + '/scripts/taso-instructions.md';

// 1) Cred stubs (only if absent — never clobber working OneCLI-managed creds)
const stub = (dir: string, scope: string) => {
  const d = HOME + '/' + dir;
  mkdirSync(d, { recursive: true });
  const keys = d + '/gcp-oauth.keys.json', creds = d + '/credentials.json';
  if (!existsSync(keys)) writeFileSync(keys, JSON.stringify({ installed: { client_id: 'onecli-managed.apps.googleusercontent.com', client_secret: 'onecli-managed', redirect_uris: ['http://localhost:3000/oauth2callback'] } }));
  if (!existsSync(creds)) writeFileSync(creds, JSON.stringify({ access_token: 'onecli-managed', refresh_token: 'onecli-managed', token_type: 'Bearer', expiry_date: 99999999999999, scope }));
  chmodSync(keys, 0o600); chmodSync(creds, 0o600);
};
stub('.gmail-mcp', 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send');
stub('.calendar-mcp', 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events');
stub('.gdrive-mcp', 'https://www.googleapis.com/auth/drive');

// 2) mount-allowlist covers the stub dirs
const malP = HOME + '/.config/nanoclaw/mount-allowlist.json';
const mal = JSON.parse(readFileSync(malP, 'utf8'));
for (const p of ['~/.gmail-mcp', '~/.calendar-mcp', '~/.gdrive-mcp'])
  if (!mal.allowedRoots.some((r: { path: string }) => r.path === p)) mal.allowedRoots.push({ path: p, allowReadWrite: true, description: p + ' OneCLI-managed credential stubs' });
const adminMcpDir = NC + '/scripts/admin-mcp';
if (!mal.allowedRoots.some((r: { path: string }) => r.path === adminMcpDir))
  mal.allowedRoots.push({ path: adminMcpDir, allowReadWrite: false, description: 'Enorasi admin-actions MCP server (read-only)' });
writeFileSync(malP, JSON.stringify(mal, null, 2));

// 3) Create the base agent only if missing (idempotent; keeps existing pairing)
const db = new Database(DBF);
let row = db.prepare('select agent_group_id as id from container_configs where assistant_name = ?').get(NAME) as { id: string } | undefined;
if (!row) {
  const mcpTmp = join(tmpdir(), 'taso-mcp.json');
  writeFileSync(mcpTmp, '{}');
  console.log('Taso missing -> creating base agent via provision-student...');
  execSync('pnpm exec tsx scripts/provision-student.ts --display-name "Taso (admin)" --agent-name Taso --folder ' + FOLDER + ' --kb-path ' + KB + ' --instructions-file ' + INSTR + ' --mcp-file ' + mcpTmp + ' --provider claude --model ' + MODEL + ' --json', { cwd: NC, stdio: 'inherit' });
  row = db.prepare('select agent_group_id as id from container_configs where assistant_name = ?').get(NAME) as { id: string };
}
const id = row.id;

// 4) Capability layer (always converge)
const pw = readFileSync(NC + '/.taso_ro_pw', 'utf8').trim();
const adminTok = readFileSync(NC + '/.taso_admin_token', 'utf8').trim();
const mcp = {
  gmail: { command: 'gmail-mcp', args: [], env: { GMAIL_OAUTH_PATH: '/workspace/extra/.gmail-mcp/gcp-oauth.keys.json', GMAIL_CREDENTIALS_PATH: '/workspace/extra/.gmail-mcp/credentials.json' } },
  postgres: { command: 'mcp-server-postgres', args: ['postgresql://taso_ro:' + pw + '@172.17.0.1:5433/enorasi'], env: {} },
  calendar: { command: 'google-calendar-mcp', args: [], env: { GOOGLE_OAUTH_CREDENTIALS: '/workspace/extra/.calendar-mcp/gcp-oauth.keys.json', GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/workspace/extra/.calendar-mcp/credentials.json' } },
  drive: { command: 'mcp-server-gdrive', args: [], env: { GDRIVE_OAUTH_PATH: '/workspace/extra/.gdrive-mcp/gcp-oauth.keys.json', GDRIVE_CREDENTIALS_PATH: '/workspace/extra/.gdrive-mcp/credentials.json' } },
  admin: { command: 'node', args: ['/workspace/extra/.admin-mcp/enorasi-admin-mcp.mjs'], env: { ENORASI_ADMIN_URL: 'https://enorasi.com', TASO_ADMIN_TOKEN: adminTok } },
};
const mounts = [
  { hostPath: KB, containerPath: 'my-kb', readonly: true },
  { hostPath: '/data/enorasi-datasets/halcyon-sales', readonly: true },
  { hostPath: '/data/enorasi-datasets/halcyon-ceo', readonly: true },
  { hostPath: '/data/enorasi-datasets/aegean', readonly: true },
  { hostPath: '~/.gmail-mcp', containerPath: '.gmail-mcp', readonly: false },
  { hostPath: '~/.calendar-mcp', containerPath: '.calendar-mcp', readonly: false },
  { hostPath: '~/.gdrive-mcp', containerPath: '.gdrive-mcp', readonly: false },
  { hostPath: NC + '/scripts/admin-mcp', containerPath: '.admin-mcp', readonly: true },
];
const instructions = readFileSync(INSTR, 'utf8');
writeFileSync(NC + '/groups/' + FOLDER + '/CLAUDE.local.md', instructions.endsWith('\n') ? instructions : instructions + '\n');
db.prepare('update container_configs set model=?, provider=?, mcp_servers=?, additional_mounts=?, updated_at=? where agent_group_id=?')
  .run(MODEL, 'claude', JSON.stringify(mcp), JSON.stringify(mounts), new Date().toISOString(), id);
console.log('Taso converged:', id, '| model:', MODEL, '| mcp:', Object.keys(mcp).join(','), '| mounts:', mounts.length);
console.log(JSON.stringify({ ok: true, agentGroupId: id }));
