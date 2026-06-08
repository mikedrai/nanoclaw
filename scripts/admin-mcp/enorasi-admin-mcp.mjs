#!/usr/bin/env node
/**
 * Enorasi admin-actions MCP server (stdio, dependency-free).
 *
 * Surfaces the website's hard-whitelisted admin actions to the Taso agent:
 *   - on startup it GETs the action catalog from `${ENORASI_ADMIN_URL}/api/admin/actions`
 *   - each catalog action becomes an MCP tool (`mcp__admin__<name>`)
 *   - tools/call POSTs `{action, params, confirm}` to the same endpoint, authed
 *     with the Taso service token (TASO_ADMIN_TOKEN).
 *
 * Destructive actions are gated server-side: without `confirm:true` the endpoint
 * returns `{needsConfirm}`, which this server relays so the agent asks the user
 * first. The website is the security boundary; this is a thin, typed proxy.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the MCP stdio transport). No npm deps —
 * just Node's global `fetch` and `readline`.
 *
 * Env: ENORASI_ADMIN_URL (default https://enorasi.com), TASO_ADMIN_TOKEN.
 */
import readline from "node:readline";

const BASE = (process.env.ENORASI_ADMIN_URL || "https://enorasi.com").replace(/\/+$/, "");
const TOKEN = process.env.TASO_ADMIN_TOKEN || "";
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** [{ name, destructive, summary, params }] — loaded from the website catalog. */
let CATALOG = [];

async function loadCatalog() {
  try {
    const res = await fetch(`${BASE}/api/admin/actions`, { headers: HEADERS });
    if (res.ok) {
      const d = await res.json();
      if (Array.isArray(d.actions)) CATALOG = d.actions;
    }
  } catch {
    /* offline / unauthorized — tools/list will just be empty */
  }
}

function toolDefs() {
  return CATALOG.map((a) => ({
    name: a.name,
    description:
      `${a.summary} Params: ${a.params}.` +
      (a.destructive
        ? ' This action is DESTRUCTIVE — show the user what it will do, get explicit confirmation, then call again with "confirm": true.'
        : ""),
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: a.destructive
        ? { confirm: { type: "boolean", description: "Set true ONLY after the user has confirmed." } }
        : {},
    },
  }));
}

async function callAction(name, args) {
  const { confirm, ...params } = args || {};
  const res = await fetch(`${BASE}/api/admin/actions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: name, params, confirm: confirm === true }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      await loadCatalog();
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "enorasi-admin", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized") {
      /* notification — no reply */
    } else if (method === "tools/list") {
      if (CATALOG.length === 0) await loadCatalog();
      reply(id, { tools: toolDefs() });
    } else if (method === "tools/call") {
      const name = params?.name;
      if (!CATALOG.some((a) => a.name === name)) {
        replyErr(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const out = await callAction(name, params?.arguments || {});
      let text;
      if (out.data && out.data.needsConfirm) {
        text =
          `⚠️ CONFIRMATION REQUIRED — "${name}" was NOT executed (nothing changed).\n` +
          `${out.data.summary}\n\n` +
          `This is irreversible. The user's request is the REQUEST, not the confirmation. ` +
          `Do NOT call this tool again with "confirm": true in this turn. STOP now: reply to the ` +
          `user stating exactly what will be permanently changed and that it cannot be undone, and ` +
          `ask them to confirm. Only after they reply in a SEPARATE, new message explicitly ` +
          `approving (e.g. "yes" / "confirm") may you call "${name}" again with "confirm": true.`;
      } else if (out.ok) {
        text = `OK: ${JSON.stringify(out.data?.result ?? out.data)}`;
      } else {
        text = `Error (${out.status}): ${out.data?.error ?? JSON.stringify(out.data)}`;
      }
      reply(id, {
        content: [{ type: "text", text }],
        isError: !out.ok && !(out.data && out.data.needsConfirm),
      });
    } else if (id !== undefined && id !== null) {
      replyErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined && id !== null) replyErr(id, -32603, e instanceof Error ? e.message : "internal error");
  }
});
