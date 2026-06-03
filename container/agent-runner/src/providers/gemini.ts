/**
 * Gemini provider — runs an agent on Google's Gemini models via `@google/genai`.
 *
 * Unlike the Claude provider (which wraps the Claude Code agent harness with a
 * built-in filesystem/tool runtime and server-side session resume), Gemini is a
 * plain stateless chat API. This provider therefore:
 *
 *   - Bridges the configured MCP servers as Gemini tools via `mcpToTool()`, so
 *     the agent gets the SAME read/write tools (Supabase, remote MCP, …) the
 *     Claude provider gets. Gemini's automatic function calling drives the
 *     tool loop. This is where two-way (read+write) MCP actually happens.
 *   - Persists conversation history to disk keyed by a session id, since Gemini
 *     has no server-side resume. The id is handed back as the `continuation`
 *     token; the host stores it and replays it on the next turn.
 *
 * Capability note: Gemini has no equivalent of the Claude Code preset, so it
 * does NOT get implicit filesystem/bash tools — only what we wire over MCP.
 * Claude remains the full-featured provider; this is the lighter alternative.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GoogleGenAI, mcpToTool } from '@google/genai';
import type { Content, Tool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/** Persistent (host-bind-mounted), agent-invisible dir for chat history. */
function sessionsDir(): string {
  return path.join(os.homedir(), '.claude', 'gemini-sessions');
}

function sessionFile(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function loadHistory(sessionId: string): Content[] {
  try {
    const raw = fs.readFileSync(sessionFile(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Content[]) : [];
  } catch {
    return []; // first turn, or unreadable — start clean
  }
}

function saveHistory(sessionId: string, history: Content[]): void {
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(sessionFile(sessionId), JSON.stringify(history));
  } catch (err) {
    console.error('[gemini] failed to persist session history', err);
  }
}

export class GeminiProvider implements AgentProvider {
  // Gemini has no native slash-command surface; let the poll-loop format them.
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, McpServerConfig>;
  private model: string;
  private apiKey?: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.model = options.model || DEFAULT_MODEL;
    this.apiKey = options.env?.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
  }

  isSessionInvalid(_err: unknown): boolean {
    // History lives in our own file; a missing file just yields an empty
    // history (fresh chat) rather than an error, so nothing to invalidate.
    return false;
  }

  /** Open a stdio MCP client per configured server. Failures are skipped. */
  private async connectMcpClients(): Promise<Client[]> {
    const clients: Client[] = [];
    for (const [name, cfg] of Object.entries(this.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...getDefaultEnvironment(), ...cfg.env },
        });
        const client = new Client({ name: `nanoclaw-${name}`, version: '1.0.0' });
        await client.connect(transport);
        clients.push(client);
      } catch (err) {
        // One bad server shouldn't sink the whole turn — log and carry on.
        console.error(`[gemini] MCP server "${name}" failed to connect`, err);
      }
    }
    return clients;
  }

  query(input: QueryInput): AgentQuery {
    const sessionId = input.continuation || randomUUID();
    const instructions = input.systemContext?.instructions;
    const model = this.model;
    const apiKey = this.apiKey;
    const connectMcpClients = () => this.connectMcpClients();

    // Push-based follow-up queue, mirroring the mock/claude providers.
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        if (!apiKey) {
          yield {
            type: 'error',
            message:
              'Gemini provider is selected but no GEMINI_API_KEY is available in the agent environment.',
            retryable: false,
            classification: 'config',
          };
          return;
        }

        yield { type: 'activity' };

        const clients = await connectMcpClients();
        // mcpToTool returns a CallableTool, accepted in the tools list at
        // runtime though the static type is Tool[]. The `any` casts bridge two
        // separate copies of the MCP SDK Client type (ours vs. genai's bundled
        // one) and genai's "at least one client" variadic signature.
        const callableFrom = mcpToTool as (...c: unknown[]) => unknown;
        const tools: Tool[] = clients.length
          ? ([callableFrom(...clients)] as unknown as Tool[])
          : [];

        try {
          const ai = new GoogleGenAI({ apiKey });
          const history = loadHistory(sessionId);
          const chat = ai.chats.create({
            model,
            history,
            config: {
              ...(instructions ? { systemInstruction: instructions } : {}),
              ...(tools.length ? { tools } : {}),
            },
          });

          yield { type: 'init', continuation: sessionId };

          // Turn loop: drain the initial prompt, then any pushed follow-ups,
          // blocking on push()/end() between turns — same shape as mock.
          for (;;) {
            if (aborted) break;
            if (pending.length === 0) {
              if (ended) break;
              await new Promise<void>((resolve) => {
                waiting = resolve;
              });
              waiting = null;
              continue;
            }

            const message = pending.shift()!;
            yield { type: 'activity' };

            let text = '';
            try {
              const stream = await chat.sendMessageStream({ message });
              for await (const chunk of stream) {
                if (aborted) break;
                yield { type: 'activity' };
                if (chunk.text) text += chunk.text;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              yield { type: 'error', message: msg, retryable: true };
              continue;
            }

            // Persist the full curated history after each completed turn so the
            // next container/turn can resume the conversation.
            saveHistory(sessionId, chat.getHistory());
            yield { type: 'result', text: text || null };
          }
        } finally {
          for (const client of clients) {
            try {
              await client.close();
            } catch {
              // best-effort — closing shouldn't fail the turn
            }
          }
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('gemini', (opts) => new GeminiProvider(opts));
