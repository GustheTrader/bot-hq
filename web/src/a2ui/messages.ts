import type { ActionMessage, CallAgentFunctionMessage, FunctionCall, JsonObject, ValidationErrorMessage } from './types';

/**
 * Builders for every renderer -> agent frame this renderer sends. Each output must validate against
 * renderer_to_agent.json (web/test/a2ui.test.ts proves it), so nothing else in the app hand-assembles frames.
 */

export function actionMessage(a: { name: string; surfaceId: string; sourceComponentId: string; context: JsonObject; at?: Date }): ActionMessage {
  return {
    version: '1.0',
    action: {
      name: a.name,
      surfaceId: a.surfaceId,
      sourceComponentId: a.sourceComponentId,
      timestamp: (a.at ?? new Date()).toISOString(),
      context: a.context,
    },
  };
}

export function callAgentFunctionMessage(surfaceId: string, functionCallId: string, callFunction: FunctionCall): CallAgentFunctionMessage {
  return { version: '1.0', callAgentFunction: { surfaceId, functionCallId, callFunction } };
}

export function validationErrorMessage(surfaceId: string, path: string, message: string): ValidationErrorMessage {
  return { version: '1.0', error: { code: 'VALIDATION_FAILED', surfaceId, path, message } };
}

/** RFC 4122 version-4 UUID; crypto.randomUUID where present (secure contexts), getRandomValues otherwise. */
export function uuidv4(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
