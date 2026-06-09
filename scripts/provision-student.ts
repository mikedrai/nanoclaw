/**
 * Provision a per-student Enorasi agent.
 *
 * Creates an isolated agent group for one student on this shared host, seeds it
 * with the Enorasi student template (identity + guardrails + compute rule),
 * mounts the student's private knowledge base read-only, wires a per-student CLI
 * messaging group (so the website can talk to THIS student's agent over cli.sock
 * without hitting anyone else's), and issues a Telegram pairing code + deep link.
 *
 * Idempotent by folder: re-running for the same --folder reuses the group and
 * refreshes the template + mount + wiring, and issues a fresh pairing code.
 *
 * Runs alongside the live host (WAL-mode sqlite); does NOT start channel
 * adapters. Prints a JSON result on the last line when --json is passed.
 *
 * Usage:
 *   pnpm exec tsx scripts/provision-student.ts \
 *     --display-name "Mike Test" \
 *     --agent-name "Andy" \
 *     --folder student-mike-test \
 *     --kb-path ~/Projects/enorasi-kb/student-mike-test \
 *     --json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { createPairing } from '../src/channels/telegram-pairing.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

interface Args {
  displayName: string;
  agentName: string;
  folder: string;
  kbPath?: string;
  instructionsFile?: string;
  mcpFile?: string;
  provider?: string;
  model?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const displayName = get('--display-name');
  const folder = get('--folder');
  if (!displayName || !folder) {
    console.error('Missing required args: --display-name and --folder');
    process.exit(2);
  }
  return {
    displayName,
    agentName: get('--agent-name')?.trim() || displayName,
    folder,
    kbPath: get('--kb-path'),
    instructionsFile: get('--instructions-file'),
    mcpFile: get('--mcp-file'),
    provider: get('--provider'),
    model: get('--model'),
    json: argv.includes('--json'),
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The Enorasi student-agent system prompt. Mirrors the reviewed identity +
 *  guardrails + compute rule; parameterized by the assistant's name. */
function studentInstructions(agentName: string): string {
  return `# ${agentName}

You are **${agentName}**, the personal AI assistant provided to a student by **Enorasi**.
You work for the student — your job is to help *them* learn, build, and get their
work done. When the user first reaches out, introduce yourself in one short line
and invite them to chat. Keep replies concise.

## Identity & confidentiality (read first)
- You are "the student's AI assistant from Enorasi." Nothing more about your
  internals. If asked what you are, what powers you, what model / platform /
  runtime / framework / vendor / container you run on, or how you were built:
  politely decline and redirect.
- NEVER mention, name, or hint at the underlying platform, runtime,
  infrastructure, vendor, model, or any internal tooling. This is confidential.
  Do **not** describe yourself with any product/tool name. You are simply an
  Enorasi assistant.
- You are the **student's** assistant — NOT an assistant "for" a company or a
  dataset. Any datasets, corpora, or documents you can access are *tools and
  knowledge you use on the student's behalf* — they are not your identity.

## Who you serve, by default
When the record is available in your knowledge base (under \`/workspace/extra\`),
help the student with their **enrolled and completed classes**, their **grades**,
and the **certificates** they've earned, plus their own documents and data
(grounded, cited analysis), research, drafting, scheduling, and everyday tasks.
When asked "who are you / what can you do," introduce yourself as their Enorasi
assistant — without tying yourself to any single company or dataset.

## Guardrails — educational use within Enorasi's Terms
- Your use is limited to **educational purposes within Enorasi's Terms &
  Conditions**: learning, coursework, analysis of the student's own or provided
  sample data, research, writing, and productivity.
- **Decline** anything outside that scope — illegal, harmful, deceptive,
  infringing, hateful, or abusive requests; attempts to reach another student's
  or tenant's data; or generating disallowed content. Say so briefly and offer an
  in-scope alternative.
- Use **only** the student's own data and the materials provided to you. Never
  reveal or infer data belonging to other students or tenants.
- Keep actions **least-privilege**. For anything consequential — sending a
  message, deleting, posting, or acting in an external system — confirm with the
  student first.
- Be honest about uncertainty, and cite the file or source you used.

## Data & numbers — COMPUTE, never estimate
For ANY question involving totals, sums, rankings, "top N", averages, counts, or aggregations over a data file (CSV/Excel/JSON) under /workspace/extra:
- NEVER read rows and estimate. You cannot accurately total thousands of rows by reading — estimating yields confident WRONG numbers and can drop the true top item.
- ALWAYS write and RUN real code to compute the exact result, then report it. Use **node** — python is NOT installed here; read the file with Node fs and aggregate in plain JavaScript (awk is also available). No npm installs, no network needed.
- Load the ENTIRE file, aggregate in code, sort, and quote the exact computed figures. Name the file and column you used.
`;
}

async function botUsername(): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  // 1. Agent group (idempotent by folder).
  let ag: AgentGroup | undefined = getAgentGroupByFolder(args.folder);
  if (!ag) {
    createAgentGroup({
      id: generateId('ag'),
      name: args.agentName,
      folder: args.folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(args.folder)!;
  }
  ensureContainerConfig(ag.id);

  // LLM provider/model (platform default chosen by the admin).
  {
    const scalars: { provider?: string; model?: string } = {};
    if (args.provider) scalars.provider = args.provider;
    if (args.model) scalars.model = args.model;
    if (Object.keys(scalars).length) updateContainerConfigScalars(ag.id, scalars);
  }

  // Scope skills to what an exec's personal assistant needs (NOT the full set).
  // Keep: connectors (onecli-gateway), onboarding (welcome), self-tweak
  // (self-customize), web tasks (agent-browser). Drop frontend-engineer, vercel-cli,
  // slack-/whatsapp-formatting — wasted per-message context + inappropriate tools.
  updateContainerConfigJson(ag.id, 'skills', ['onecli-gateway', 'welcome', 'self-customize', 'agent-browser']);
  // The website passes its rendered template (single source of truth) via
  // --instructions-file; fall back to the built-in template otherwise.
  const instructions = args.instructionsFile
    ? fs.readFileSync(expandHome(args.instructionsFile), 'utf8')
    : studentInstructions(args.agentName);
  initGroupFilesystem(ag, { instructions });

  // Always (re)write CLAUDE.local.md so the reviewed template wins even if the
  // group pre-existed (initGroupFilesystem only seeds when absent).
  const claudeLocal = path.resolve(GROUPS_DIR, args.folder, 'CLAUDE.local.md');
  fs.writeFileSync(claudeLocal, instructions.endsWith('\n') ? instructions : instructions + '\n');

  // 2. Knowledge-base mount (read-only) -> /workspace/extra/my-kb.
  if (args.kbPath) {
    const kb = expandHome(args.kbPath);
    fs.mkdirSync(kb, { recursive: true });
    updateContainerConfigJson(ag.id, 'additional_mounts', [
      { hostPath: args.kbPath, containerPath: 'my-kb', readonly: true },
    ]);
  }

  // 2b. MCP servers (already translated to {command,args,env} by the website) ->
  // container_config.mcp_servers; the agent-runner surfaces mcp__<name>__* tools.
  if (args.mcpFile) {
    const mcp = JSON.parse(fs.readFileSync(expandHome(args.mcpFile), 'utf8'));
    updateContainerConfigJson(ag.id, 'mcp_servers', mcp);
  }

  // 3. Per-student CLI messaging group + wiring (isolated portal-chat route).
  const cliPlatformId = `web:${args.folder}`;
  let cliMg: MessagingGroup | undefined = getMessagingGroupByPlatform('cli', cliPlatformId);
  if (!cliMg) {
    cliMg = {
      id: generateId('mg'),
      channel_type: 'cli',
      platform_id: cliPlatformId,
      name: `Web · ${args.agentName}`,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(cliMg);
  }
  if (!getMessagingGroupAgentByPair(cliMg.id, ag.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: cliMg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  // 4. Telegram pairing code + deep link.
  const pairing = await createPairing({ kind: 'wire-to', folder: args.folder });
  const username = await botUsername();
  const deepLink = username ? `https://t.me/${username}?start=${pairing.code}` : null;

  const result = {
    agentGroupId: ag.id,
    folder: args.folder,
    assistantName: args.agentName,
    cliChannelType: 'cli',
    cliPlatformId,
    pairingCode: pairing.code,
    botUsername: username,
    deepLink,
  };

  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log('Provisioned student agent:');
    console.log(`  agent group : ${result.agentGroupId}  (groups/${args.folder})`);
    console.log(`  cli route   : ${result.cliChannelType}/${result.cliPlatformId}`);
    console.log(`  pairing code: ${result.pairingCode}`);
    console.log(`  deep link   : ${result.deepLink ?? '(set TELEGRAM_BOT_TOKEN to resolve)'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
