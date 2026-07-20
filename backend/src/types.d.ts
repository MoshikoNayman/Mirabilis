// Shared type definitions for the Mirabilis backend.
//
// These are consumed from plain JS via JSDoc, e.g.:
//   /** @typedef {import('./types.js').Provider} Provider */
// (TypeScript resolves the sibling .d.ts for the ./types.js specifier.)
//
// Opt a file into checking with `// @ts-check` at the top. Nothing here changes
// runtime behavior; it exists only for the type-checker and the editor.

/** Every provider the app can talk to (chat + model listing). */
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

/** Inference runtimes registered in the runtime registry. */
export type RuntimeKind = 'ollama' | 'llamacpp' | 'openai-compatible' | 'vllm' | 'koboldcpp';

/** Capability-router task lanes. */
export type Lane = 'general' | 'reasoning' | 'coding' | 'experimental';

/** A stored file attached to a chat message. */
export interface Attachment {
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
  url: string;
}

/** Exact-or-estimated generation metrics attached to an assistant message. */
export interface PerformanceReceipt {
  source: 'ollama' | 'timing';
  tokens?: number;
  tokensPerSec?: number;
  promptTokens?: number;
  ttftMs?: number;
  wallMs?: number;
  isEstimate?: boolean;
}

/** A persisted chat message. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: 'attachments' | undefined;
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

/** One base64-encoded image forwarded to a vision model. */
export interface ProviderImage {
  mime: string;
  data: string;
}

/** A message as handed to a provider adapter (may carry vision images). */
export interface OutgoingMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: ProviderImage[];
}

/** An item in the model picker returned by GET /api/models. */
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

/** A model considered by the capability router. */
export interface AvailableModel {
  id?: string;
  name?: string;
  sizeBytes?: number;
  paramSize?: string | null;
  quant?: string;
  uncensored?: boolean;
}

export interface RouteArgs {
  prompt?: string;
  lane?: Lane;
  availableModels?: AvailableModel[];
  ramGb?: number;
  uncensored?: boolean;
}

export interface RouteResult {
  model: string | null;
  lane: Lane;
  reason: string;
}

/** A declarative runtime definition (RUNTIMES entries). */
export interface RuntimeDef {
  id: string;
  kind: RuntimeKind;
  label: string;
  scope: string;
  transport: 'ollama' | 'openai';
  managed: 'external' | 'spawn' | 'spawn-or-external';
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  defaultPort?: number;
  binaryCandidates?: string[];
  capabilities: Record<string, unknown>;
  note?: string;
}

/** The serializable runtime view returned by listRuntimes(). */
export interface RuntimeInfo {
  id: string;
  label: string;
  kind: RuntimeKind;
  scope: string;
  transport: 'ollama' | 'openai';
  managed: string;
  capabilities: Record<string, unknown>;
  canPull: boolean;
  note?: string;
  localLaunchable: boolean;
  available: boolean;
  remoteOnlyReason: string | null;
}

/** Managed-runtime status (llama.cpp / vLLM). */
export interface RuntimeStatus {
  running: boolean;
  installed?: boolean;
  pid?: number;
  port?: number;
  baseUrl?: string;
  model?: string;
  startedAt?: number;
}

/** vLLM local-capability probe result. */
export interface VllmCapability {
  canRunLocal: boolean;
  appleSilicon?: boolean;
  hasNvidia: boolean;
  installed: boolean;
  launcher?: 'cli' | 'python' | null;
  python?: string | null;
  reason: string | null;
}

/** Per-model facts from Ollama /api/show. */
export interface OllamaModelInfo {
  contextWindow: number | null;
  paramCount: number | null;
  capabilities: string[];
  vision: boolean;
}

/** Exact eval metrics streamed back from Ollama's final chunk. */
export interface OllamaStats {
  evalCount?: number | null;
  evalDurationNs?: number | null;
  promptEvalCount?: number | null;
}

export type OnToken = (token: string) => void;
export type OnStats = (stats: OllamaStats) => void;
export type OnNotice = (message: string) => void;

/** Common arguments shared by every streaming provider adapter. */
export interface StreamArgs {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  messages: OutgoingMessage[];
  signal?: AbortSignal;
  onToken?: OnToken;
  onStats?: OnStats;
  onNotice?: OnNotice;
  temperature?: number | null;
  maxTokens?: number | null;
  keepAlive?: string | number | null;
  params?: Record<string, unknown>;
  options?: Record<string, unknown>;
  providerLabel?: string;
}
