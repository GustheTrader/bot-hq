import { getAt } from './pointer';
import { isBinding, isFunctionCall, isObject, type FunctionCall, type Json, type JsonObject } from './types';

/**
 * Resolve a dynamic value against a surface data model: {"@path": "/x"} reads the model, literals pass through,
 * arrays and plain objects resolve element-wise. Nested function calls are not evaluated renderer-side in this
 * MVP (the one catalog has no renderer functions), so they are an error rather than a silent pass-through.
 */
export function resolveValue(v: Json | undefined, model: JsonObject): Json | undefined {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  if (isBinding(v)) return getAt(model, v['@path']);
  if (isFunctionCall(v)) throw new Error(`Nested function call "${v['@call']}" is not supported in this renderer`);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, model) ?? null);
  const out: JsonObject = {};
  for (const [k, x] of Object.entries(v)) {
    const r = resolveValue(x, model);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

/**
 * Turn a component's functionCall (args holding @path bindings) into the wire callFunction with literal args, as
 * callAgentFunction requires. A binding that resolves to nothing is an error: the agent must never receive an
 * order with a hole in it.
 */
export function resolveFunctionCall(call: FunctionCall, model: JsonObject): FunctionCall {
  const out: FunctionCall = { '@call': call['@call'] };
  if (call.catalogId) out.catalogId = call.catalogId;
  if (call.args) {
    const args: JsonObject = {};
    for (const [k, v] of Object.entries(call.args)) {
      const r = resolveValue(v, model);
      if (r === undefined || r === null) throw new Error(`Argument "${k}" of ${call['@call']} has no value`);
      args[k] = r;
    }
    out.args = args;
  }
  return out;
}

/** The functionCall inside an Action ({"functionCall": {...}}), if that is what the prop holds. */
export function actionFunctionCall(action: Json | undefined): FunctionCall | null {
  if (!isObject(action)) return null;
  const fc = (action as JsonObject).functionCall;
  return isFunctionCall(fc) ? (fc as unknown as FunctionCall) : null;
}
