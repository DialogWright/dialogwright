/**
 * The model client of the converse runtime: one streaming, tool-calling interface over the Anthropic
 * Messages API and OpenAI-compatible chat completions (Inception, OpenRouter). A client never throws
 * while streaming: a failure is an `error` event, and the stream ends.
 */

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContent[];
}

export interface ModelTool {
  name: string;
  description: string;
  /** A JSON Schema object. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxTokens: number;
  temperature?: number;
}

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'done'; stop: 'end' | 'tool' | 'length'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; kind: 'timeout' | 'filtered' | 'http' | 'invalid'; detail: string };

export interface ConverseModel {
  readonly id: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
