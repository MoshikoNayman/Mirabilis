// Shared client-side type definitions for the Mirabilis frontend.
//
// This mirrors the client/server contract (kept in sync with
// backend/src/types.d.ts by hand for now; a shared package is a later step).
// Consumed from JS via JSDoc, e.g.
//   /** @typedef {import('../types.js').ChatMessage} ChatMessage */
// Opt a file into checking with `// @ts-check`. No runtime effect.

/** Every provider the picker can select. */
export type Provider =
  | 'ollama'
  | 'llamacpp'
  | 'openai-compatible'
  | 'koboldcpp'
  | 'vllm'
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'groq'
  | 'openrouter'
  | 'cerebras'
  | 'gpuaas';

/** ICQ-style presence states rendered by the Buddy List / StatusOrb. */
export type PresenceState = 'online' | 'away' | 'needkey' | 'busy' | 'offline' | 'unknown';

/** Provider metadata used for presence probing. */
export interface ProviderMeta {
  id: string;
  label: string;
  scope: 'local' | 'remote';
  needsKey?: boolean;
  requiresBinary?: boolean;
  baseUrl?: string;
}

/** Per-provider endpoint config stored in the UI. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

/** A stored file attached to a chat message. */
export interface Attachment {
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
  url: string;
}

/** Exact-or-estimated generation metrics on an assistant message. */
export interface PerformanceReceipt {
  source: 'ollama' | 'timing';
  tokens?: number;
  tokensPerSec?: number;
  promptTokens?: number;
  ttftMs?: number;
  wallMs?: number;
  isEstimate?: boolean;
}

/** A chat message as held in the UI. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: 'attachments';
  attachments?: Attachment[];
  createdAt?: string;
  tokenEstimate?: number;
  performance?: PerformanceReceipt;
  provider?: Provider;
  model?: string;
  effectiveProvider?: Provider;
  effectiveModel?: string;
  imageUrl?: string;
  imageGenerating?: boolean;
}

/** An item in the model picker (GET /api/models). */
export interface ModelListItem {
  id: string;
  label: string;
  group?: string;
  available?: boolean;
  selected?: boolean;
  paramSize?: string | null;
  ollamaId?: string;
  size?: string;
  modelFilePath?: string;
  sizeBytes?: number;
}

/** GET /api/models response. */
export interface ModelsResponse {
  provider: string;
  models: ModelListItem[];
}

/** SSE events streamed from POST /api/chats/:id/messages/stream. */
export interface StreamMetaEvent {
  provider: Provider;
  model: string;
  userMessageId: string;
  promptTokenEstimate: number;
  numCtx: number | null;
  tuning: unknown;
}
export interface StreamTokenEvent { token: string; }
export interface StreamNoticeEvent { message: string; }
export interface StreamErrorEvent { error: string; }
export interface StreamDoneEvent {
  message: {
    id: string;
    role: 'assistant';
    content: string;
    performance?: PerformanceReceipt;
    effectiveProvider?: Provider;
    effectiveModel?: string;
  };
}
