import { isObject, type Json, type JsonObject } from './types';

/**
 * RFC 6901 JSON Pointer helpers over the surface data model. All writes are immutable (structural sharing), so
 * zustand selectors on untouched branches keep their identity and do not re-render.
 */

export function parsePointer(path: string | undefined): string[] {
  if (path === undefined || path === '' || path === '/') return [];
  if (!path.startsWith('/')) throw new Error(`JSON Pointer must start with "/": ${path}`);
  return path.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function getAt(root: Json | undefined, path: string | undefined): Json | undefined {
  let cur: Json | undefined = root;
  for (const tok of parsePointer(path)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(tok)) return undefined;
      cur = cur[Number(tok)];
    } else if (isObject(cur)) {
      cur = Object.prototype.hasOwnProperty.call(cur, tok) ? (cur as JsonObject)[tok] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * updateDataModel semantics: set `value` at `path`; `value === null` deletes the key (or array element) at
 * `path`. Path omitted / "/" replaces the whole model (null there resets it to {}). Missing intermediate
 * containers are created as objects.
 */
export function applyAt(root: JsonObject, path: string | undefined, value: Json): JsonObject {
  const toks = parsePointer(path);
  if (toks.length === 0) return value === null ? {} : isObject(value) ? (value as JsonObject) : root;
  return writeAt(root, toks, 0, value) as JsonObject;
}

function writeAt(node: Json | undefined, toks: string[], i: number, value: Json): Json | undefined {
  const tok = toks[i];
  const last = i === toks.length - 1;
  if (Array.isArray(node)) {
    const idx = tok === '-' ? node.length : /^(0|[1-9]\d*)$/.test(tok) ? Number(tok) : -1;
    // Not addressable (non-numeric, or past the end, which would pad holes / build a huge sparse array).
    if (idx < 0 || idx > node.length) return node;
    const next = node.slice();
    if (last) {
      if (value === null) { if (idx < next.length) next.splice(idx, 1); }
      else next[idx] = value;
      return next;
    }
    const child = writeAt(node[idx], toks, i + 1, value);
    if (child === undefined) return node; // deleting below a missing element: no-op, no phantom {}
    next[idx] = child;
    return next;
  }
  if (value === null && !isObject(node)) return node; // deleting under a missing branch is a no-op
  const obj: JsonObject = isObject(node) ? { ...(node as JsonObject) } : {};
  if (last) {
    if (value === null) delete obj[tok];
    else obj[tok] = value;
    return obj;
  }
  const prev = Object.prototype.hasOwnProperty.call(obj, tok) ? obj[tok] : undefined;
  const child = writeAt(prev, toks, i + 1, value);
  if (isObject(node) && child === prev) return node; // nothing changed below: keep identity
  if (child === undefined) delete obj[tok];
  else obj[tok] = child;
  return obj;
}
