export const KNOWN_APIS = [
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
] as const;

export type KnownApi = (typeof KNOWN_APIS)[number];
export type ModelInput = "text" | "image";

export interface CostConfig {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ModelInput[];
  cost: CostConfig;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelConfig[];
  modelOverrides?: Record<string, Partial<ModelConfig>>;
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

export interface ModelPolicy {
  mode: "includeAll" | "includeOnly";
  include?: string[];
  exclude?: string[];
}

export interface DiscoveryConfig {
  mode: "endpoint" | "manual";
  modelsPath: string;
  /** Full discovery URL override. Wins over baseUrl + modelsPath (e.g. Ollama's http://host:11434/api/tags). */
  modelsUrl?: string;
  /** Opt-in: when the configured URL 404s, shape-misses, or returns empty, probe common paths. */
  probe?: boolean;
  /** Opt-in: probe the endpoint for accepted reasoning_effort values on refresh (openai-completions profiles only). */
  reasoningProbe?: boolean;
  modelIds?: string[];
}

export interface EndpointProfile {
  id: string;
  enabled: boolean;
  name: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  discovery: DiscoveryConfig;
  modelPolicy: ModelPolicy;
  parameterSourceSelections?: Record<string, string>;
  modelOverrides?: Record<string, Partial<ModelConfig>>;
  /** Manual reasoning_effort values the endpoint accepts; wins over probe results. */
  reasoningEfforts?: string[];
}

export type EndpointAuthMode = "none" | "environment" | "literal" | "command";

export interface EndpointDraft {
  originalId?: string;
  id: string;
  name: string;
  enabled: boolean;
  api?: string;
  baseUrl: string;
  authMode: EndpointAuthMode;
  authValue: string;
  discoveryMode: "endpoint" | "manual";
  modelsPath: string;
  modelsUrl: string;
  probe: boolean;
  reasoningProbe: boolean;
  reasoningEfforts: string;
  modelIds: string;
  headersJson: string;
}

export interface EndpointManagerData {
  config: ManagedConfig;
  cache?: DiscoveryCache;
  doctor: DoctorReport;
  runtimeApis: string[];
}

export interface EndpointSaveResult {
  data: EndpointManagerData;
  profileId: string;
  modelCount: number;
}

export interface EndpointManagerOperations {
  testConnection(profile: EndpointProfile, signal: AbortSignal): Promise<EndpointDiscoveryResult>;
  saveProfile(profile: EndpointProfile, originalId: string | undefined, discovery: EndpointDiscoveryResult | undefined, signal: AbortSignal): Promise<EndpointSaveResult>;
  refresh(profileId: string | undefined, signal: AbortSignal): Promise<EndpointManagerData>;
  deleteProfile(profileId: string): Promise<EndpointManagerData>;
  cloneProfile(profileId: string): Promise<EndpointManagerData>;
  saveModelChanges(profileId: string, changes: { policy: ModelPolicy; sources: Record<string, string> }): Promise<EndpointManagerData>;
  editModelFields(profileId: string, modelId: string): Promise<EndpointManagerData>;
  editCustomOverrides(): Promise<EndpointManagerData>;
  sendTestMessage(profileId: string, modelId: string, signal: AbortSignal): Promise<TestMessageResult | undefined>;
  probeReasoning(profileId: string, modelId: string | undefined, signal: AbortSignal): Promise<EndpointManagerData>;
}

export interface ManagedConfig {
  version: 1;
  profiles: Record<string, EndpointProfile>;
  modelOverrides?: Record<string, Partial<ModelConfig>>;
  settings?: {
    staleReminder?: boolean;
    staleReminderDays?: number;
  };
}

export interface EndpointModel {
  id: string;
  name?: string;
  available?: boolean;
}

export interface EndpointDiscoveryResult {
  models: EndpointModel[];
  warnings: string[];
  /** The URL that actually returned the model list (after probing, when enabled). */
  discoveryUrl?: string;
}

export type TestMessageResult =
  | { status: "success"; latencyMs: number; replyPreview: string }
  | { status: "cancelled" }
  | { status: "timeout" }
  | { status: "failed"; message: string };

export interface ProfileHealth {
  lastTestAt?: string;
  lastTestMs?: number;
  lastModelId?: string;
  failureCount?: number;
  lastError?: string;
}

export type ParameterSourceType = "pi-built-in" | "models.dev" | "generated-default";
export type MatchKind = "exact" | "normalized" | "fuzzy" | "none";

export interface ParameterSourceCandidate {
  sourceId: string;
  sourceType: ParameterSourceType;
  provider?: string;
  modelId: string;
  match: MatchKind;
  model: ModelConfig;
}

export interface CachedModel {
  id: string;
  name?: string;
  available: boolean;
  candidates: ParameterSourceCandidate[];
}

export interface CachedProfile {
  refreshedAt: string;
  endpointModels: EndpointModel[];
  models: Record<string, CachedModel>;
  warnings: string[];
  /** Resolved discovery URL after probing (so later refreshes skip the guessing game). */
  discoveryUrl?: string;
  /** Per-profile test health history, updated on every test message. */
  health?: ProfileHealth;
  /** Live reasoning_effort probe outcome (openai-completions profiles with discovery.reasoningProbe). */
  reasoning?: ReasoningProbeResult;
}

/** Outcome of probing an endpoint for accepted reasoning_effort values. */
export interface ReasoningProbeResult {
  probedAt: string;
  /** Model id the probe sent requests as (first available reasoning model). */
  modelId: string;
  /** Effort values the endpoint accepted (HTTP 2xx). */
  accepted: string[];
  /** Effort values the endpoint rejected with 400/422, with the reason. */
  rejected: Array<{ value: string; status: number; detail: string; effortRelated: boolean }>;
  /** Fatal failure (auth, network, non-400 status) — the probe never completed. */
  error?: string;
}

export interface DiscoveryCache {
  version: 1;
  profiles: Record<string, CachedProfile>;
}

export interface BuiltInModelRecord extends ModelConfig {
  provider: string;
  api: string;
}

export interface ModelsDevRecord extends ModelConfig {
  provider: string;
}

export interface RuntimeCapabilities {
  adapters: string[];
  builtInModels: BuiltInModelRecord[];
}

export interface FileLoadResult<T> {
  value?: T;
  error?: string;
  missing: boolean;
}

export interface DoctorIssue {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  profileId?: string;
}

export interface DoctorReport {
  configDir: string;
  issues: DoctorIssue[];
}
