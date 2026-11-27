/**
 * A2UI v1.0 wire types (the subset this renderer speaks). The shapes follow the official schemas in
 * agents/a2ui-durable/schemas/v1_0/ and the bot-HQ wire contract in docs/a2ui/CONTRACT.md.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface DataBinding { '@path': string }
export interface FunctionCall { '@call': string; catalogId?: string; args?: { [k: string]: Json } }

/** One component as it arrives on the wire: common envelope + catalog-specific properties. */
export interface WireComponent {
  id: string;
  component: string;
  '@catalogId'?: string;
  [prop: string]: Json | undefined;
}

export interface CreateSurfaceMessage {
  version: '1.0';
  createSurface: {
    surfaceId: string;
    catalogId?: string;
    sendDataModel?: boolean;
    components?: WireComponent[];
    dataModel?: JsonObject;
    metadata?: JsonObject;
  };
}
export interface UpdateComponentsMessage { version: '1.0'; updateComponents: { surfaceId: string; components: WireComponent[] } }
export interface UpdateDataModelMessage { version: '1.0'; updateDataModel: { surfaceId: string; path?: string; value: Json } }
export interface DeleteSurfaceMessage { version: '1.0'; deleteSurface: { surfaceId: string } }

/** Exactly one of `value` / `error` (agent_to_renderer.json), modelled as a union so neither / both cannot type-check. */
export type FunctionResponse =
  | { functionCallId: string; value: Json; error?: never }
  | { functionCallId: string; error: { code: string; message: string }; value?: never };
export interface AgentFunctionResponseMessage { version: '1.0'; agentFunctionResponse: FunctionResponse }

export type AgentMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataModelMessage
  | DeleteSurfaceMessage
  | AgentFunctionResponseMessage;

/* ---------- renderer -> agent ---------- */

export interface ActionMessage {
  version: '1.0';
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: JsonObject;
    userMessage?: string;
  };
}
export interface CallAgentFunctionMessage {
  version: '1.0';
  callAgentFunction: { surfaceId: string; functionCallId: string; callFunction: FunctionCall };
}
export interface ValidationErrorMessage {
  version: '1.0';
  error: { code: 'VALIDATION_FAILED'; surfaceId: string; path: string; message: string };
}
export type RendererMessage = ActionMessage | CallAgentFunctionMessage | ValidationErrorMessage;

export const isObject = (v: unknown): v is { [k: string]: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isBinding = (v: unknown): v is DataBinding =>
  isObject(v) && typeof v['@path'] === 'string' && Object.keys(v).length === 1;

export const isFunctionCall = (v: unknown): v is FunctionCall =>
  isObject(v) && typeof v['@call'] === 'string'
  && (v.catalogId === undefined || typeof v.catalogId === 'string')
  && (v.args === undefined || isObject(v.args));

/** Own-property lookup, so ids like "constructor" or "__proto__" never hit Object.prototype. */
export const own = <T>(m: Record<string, T>, k: string | undefined): T | undefined =>
  k !== undefined && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
