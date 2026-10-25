import { readFileSync } from 'node:fs';
import { asset } from './assets.js';

// One small interface in front of every model provider Haulback can use.
// Model specs look like "provider:model":
//   grok:grok-4.7          xAI Responses-compatible chat endpoint
//   Claude:claude-sonnet-4-5
//   openai:gpt-5-mini
//   oss:openai/gpt-oss-20b  any OpenAI-compatible endpoint (OSS_BASE_URL)
//   baseline:rules          no model at all; callers use their rule-based path

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
};
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};
export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
};

type Price = { inputPer1M: number; outputPer1M: number; same_as?: string };
const PRICES: Record<string, Price> = JSON.parse(readFileSync(asset('models.json'), 'utf8'));

export function parseSpec(spec: string): { provider: string; model: string } {
  const at = spec.indexOf(':');
  if (at <= 0) throw new Error(`model spec "${spec}" must look like provider:model`);
  return { provider: spec.slice(0, at).toLowerCase(), model: spec.slice(at + 1) };
}

export function isBaseline(spec: string): boolean {
  return parseSpec(spec).provider === 'baseline';
}

export function costOf(spec: string, inputTokens: number, outputTokens: number): number {
  let price: Price | undefined = PRICES[spec];
  if (price && price.inputPer1M === 0 && price.outputPer1M === 0) return 0;
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}

// Default model choice: a free open model when a Groq key exists, then each
// paid provider in the order the job lists them, then the offline baseline.
export function defaultModel(kind: 'draft' = 'draft'): string {
  void kind;
  if (process.env.DRAFT_MODEL) return process.env.DRAFT_MODEL;
  if (process.env.GROQ_API_KEY) return 'oss:openai/gpt-oss-20b';
  if (process.env.XAI_API_KEY) return 'grok:grok-4.7';
  if (process.env.ANTHROPIC_API_KEY) return 'Claude:claude-sonnet-4-5';
  if (process.env.OPENAI_API_KEY) return 'openai:gpt-5';
  return 'baseline:rules';
}

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = fetch;
export function setFetchForTests(fn: FetchFn): void { fetchImpl = fn; }

const RETRYABLE = new Set([402, 408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    const started = Date.now();
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) {
        void started;
        return JSON.parse(text) as Record<string, unknown>;
      }
      lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
      if (!RETRYABLE.has(res.status)) throw lastErr;
    } catch (err) {
      lastErr = err as Error;
      if (attempt === 3) throw lastErr;
    }
  }
  throw lastErr ?? new Error('request failed');
}

// --- OpenAI-compatible providers (OpenAI, Grok, OSS endpoints) -------------


// Tool-call arguments arrive as a JSON string from spec-compliant
// endpoints, but some OpenAI-compatible servers return an object.
// Accept both; anything else becomes {} and fails decision validation
// downstream, which the drafting loop turns into a retry.
export function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function compatMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function chatCompat(
  spec: string, baseUrl: string, apiKey: string,
  messages: Message[], tools: ToolDef[] | undefined, json: boolean,
): Promise<ChatResult> {
  const { model } = parseSpec(spec);
  const body: Record<string, unknown> = { model, messages: compatMessages(messages), temperature: 0 };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  } else if (json) {
    body.response_format = { type: 'json_object' };
  }
  const t0 = Date.now();
  const data = await postJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { authorization: `Bearer ${apiKey}` }, body);
  const ms = Date.now() - t0;
  const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const msg = (choice?.message ?? {}) as Record<string, unknown>;
  const toolCalls: ToolCall[] = ((msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? []).map((c, i) => {
    const fn = (c.function ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    args = parseToolArgs(fn.arguments);
    return { id: String(c.id ?? `call-${i}`), name: String(fn.name ?? ''), args };
  });
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls, inputTokens, outputTokens, costUsd: costOf(spec, inputTokens, outputTokens), ms };
}

// --- Anthropic --------------------------------------------------------------

export function anthropicMessages(messages: Message[]): { system: string; messages: Array<Record<string, unknown>> } {
  let system = '';
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') system = system ? `${system}\n\n${m.content}` : m.content;
    else if (m.role === 'tool') out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
    else if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
      out.push({ role: 'assistant', content });
    } else out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return { system, messages: out };
}

async function chatAnthropic(
  spec: string, apiKey: string, messages: Message[], tools: ToolDef[] | undefined,
): Promise<ChatResult> {
  const { model } = parseSpec(spec);
  const { system, messages: msgs } = anthropicMessages(messages);
  const body: Record<string, unknown> = { model, max_tokens: 1024, temperature: 0, messages: msgs };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const t0 = Date.now();
  const data = await postJson('https://api.anthropic.com/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body);
  const ms = Date.now() - t0;
  const blocks = (data.content as Array<Record<string, unknown>> | undefined) ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
  const toolCalls: ToolCall[] = blocks.filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: (b.input ?? {}) as Record<string, unknown> }));
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  return { text, toolCalls, inputTokens, outputTokens, costUsd: costOf(spec, inputTokens, outputTokens), ms };
}

// --- Entry point --------------------------------------------------------------

export async function chat(o: {
  model: string; messages: Message[]; tools?: ToolDef[]; json?: boolean;
}): Promise<ChatResult> {
  const { provider } = parseSpec(o.model);
  switch (provider) {
    case 'grok': {
      const key = process.env.XAI_API_KEY;
      if (!key) throw new Error('XAI_API_KEY is not set');
      return chatCompat(o.model, 'https://api.x.ai/v1', key, o.messages, o.tools, o.json ?? false);
    }
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY is not set');
      return chatCompat(o.model, 'https://api.openai.com/v1', key, o.messages, o.tools, o.json ?? false);
    }
    case 'oss': {
      const key = process.env.GROQ_API_KEY ?? process.env.OSS_API_KEY;
      if (!key) throw new Error('GROQ_API_KEY (or OSS_API_KEY) is not set');
      return chatCompat(o.model, process.env.OSS_BASE_URL ?? 'https://api.groq.com/openai/v1', key, o.messages, o.tools, o.json ?? false);
    }
    case 'Claude': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
      return chatAnthropic(o.model, key, o.messages, o.tools);
    }
    case 'baseline':
      throw new Error('baseline:rules has no chat endpoint; callers use the rule-based path');
    default:
      throw new Error(`unknown model provider "${provider}"`);
  }
}
