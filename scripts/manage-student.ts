/**
 * Manage a per-student Enorasi agent on this host — the live-side of the
 * website's portal controls. Uses nanoclaw's own DB functions (no approval gate)
 * plus docker for container lifecycle.
 *
 *   --action reconfigure  --agent-group-id --folder --assistant-name --instructions-file
 *       Rewrite CLAUDE.local.md (from the website's rendered template), set the
 *       assistant/group name, and stop the container so it respawns with the new
 *       prompt on the next message.
 *   --action stop   --agent-group-id --folder
 *       Durably pause: set every wiring's engage pattern to a never-match regex
 *       (no channel — web or Telegram — reaches the agent) and stop the container.
 *   --action start  --agent-group-id
 *       Resume: restore engage patterns to always-on.
 *   --action delete --agent-group-id --folder
 *       Tear down: remove the container, delete the agent group (cascades wirings/
 *       sessions), and remove the on-disk group + session dirs.
 *
 * Usage: pnpm exec tsx scripts/manage-student.ts --action <a> --agent-group-id <id> ...
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAgentGroup, updateAgentGroup } from '../src/db/agent-groups.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { updateMessagingGroupAgent } from '../src/db/messaging-groups.js';

const NEVER_MATCH = '$^'; // end-anchor then start-anchor: matches no message
const ALWAYS = '.';

function get(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
}

function containersFor(folder: string): string[] {
  try {
    const out = execFileSync('docker', ['ps', '-aq', '--filter', `name=nanoclaw-v2-${folder}`], {
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function dockerDo(verb: 'stop' | 'rm', folder: string): void {
  for (const id of containersFor(folder)) {
    try {
      execFileSync('docker', verb === 'rm' ? ['rm', '-f', id] : ['stop', id], { stdio: 'ignore' });
    } catch {
      /* container already gone / not running */
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const action = get(argv, '--action');
  const agentGroupId = get(argv, '--agent-group-id');
  if (!action || !agentGroupId) {
    console.error('Missing --action or --agent-group-id');
    process.exit(2);
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  // The REAL on-disk folder is whatever the agent group says — never assume
  // `student-<id>` (legacy hand-wired groups use a different folder). Fall back
  // to the passed --folder only if the group can't be found.
  const folder = getAgentGroup(agentGroupId)?.folder ?? get(argv, '--folder');

  const wiringIds = (
    db.prepare('SELECT id FROM messaging_group_agents WHERE agent_group_id = ?').all(agentGroupId) as {
      id: string;
    }[]
  ).map((r) => r.id);

  switch (action) {
    case 'reconfigure': {
      const assistantName = get(argv, '--assistant-name');
      const instructionsFile = get(argv, '--instructions-file');
      if (instructionsFile && folder) {
        const body = fs.readFileSync(instructionsFile, 'utf8');
        const dest = path.resolve(GROUPS_DIR, folder, 'CLAUDE.local.md');
        fs.writeFileSync(dest, body.endsWith('\n') ? body : body + '\n');
      }
      if (assistantName) {
        updateContainerConfigScalars(agentGroupId, { assistant_name: assistantName });
        updateAgentGroup(agentGroupId, { name: assistantName });
      }
      const provider = get(argv, '--provider');
      const model = get(argv, '--model');
      if (provider || model) {
        const scalars: { provider?: string; model?: string } = {};
        if (provider) scalars.provider = provider;
        if (model) scalars.model = model;
        updateContainerConfigScalars(agentGroupId, scalars);
      }
      const mcpFile = get(argv, '--mcp-file');
      if (mcpFile) {
        const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        updateContainerConfigJson(agentGroupId, 'mcp_servers', mcp);
      }
      if (folder) dockerDo('stop', folder); // respawn fresh with the new config next message
      break;
    }
    case 'stop': {
      for (const id of wiringIds)
        updateMessagingGroupAgent(id, { engage_mode: 'pattern', engage_pattern: NEVER_MATCH });
      if (folder) dockerDo('stop', folder);
      break;
    }
    case 'start': {
      for (const id of wiringIds)
        updateMessagingGroupAgent(id, { engage_mode: 'pattern', engage_pattern: ALWAYS });
      break;
    }
    case 'delete': {
      if (folder) dockerDo('rm', folder);
      // ncl does the FK-ordered cascade (wirings, sessions, configs, roles) that
      // the raw deleteAgentGroup() does not.
      const ncl = path.join(path.dirname(DATA_DIR), 'bin', 'ncl');
      execFileSync(ncl, ['groups', 'delete', '--id', agentGroupId, '--json'], { stdio: 'ignore' });
      if (folder) {
        fs.rmSync(path.resolve(GROUPS_DIR, folder), { recursive: true, force: true });
      }
      fs.rmSync(path.join(DATA_DIR, 'v2-sessions', agentGroupId), { recursive: true, force: true });
      break;
    }
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(2);
  }

  console.log(JSON.stringify({ ok: true, action, agentGroupId, wirings: wiringIds.length }));
}

main();
