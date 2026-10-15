// Versioned, typed encoding for IndexedDB's structured-clone values. No tokens
// are present: ChatGPT credentials live exclusively in the native Keychain.
export async function encode(value, depth = 0) {
  if (depth > 64) throw new Error('Save nesting exceeds the transfer limit.');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (value === undefined) return { type: 'undefined' };
  if (value instanceof Blob) return { type: 'blob', mime: value.type, data: await encode(await value.arrayBuffer(), depth + 1) };
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value); let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { type: 'bytes', data: btoa(binary) };
  }
  if (ArrayBuffer.isView(value)) return { type: 'view', name: value.constructor.name, data: await encode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), depth + 1) };
  if (value instanceof Date) return { type: 'date', data: value.toISOString() };
  if (Array.isArray(value)) return { type: 'array', data: await Promise.all(value.map(item => encode(item, depth + 1))) };
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    return { type: 'object', data: await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item, depth + 1)])) };
  }
  throw new Error('This save contains an unsupported transfer value. Export it from the game library.');
}
export function decode(value, depth = 0) {
  if (depth > 64) throw new Error('Invalid save archive.');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  const data = value?.data;
  switch (value?.type) {
    case 'undefined': return undefined;
    case 'date': return new Date(data);
    case 'bytes': return Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer;
    case 'blob': return new Blob([decode(data, depth + 1)], { type: value.mime });
    case 'view': {
      const types = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray, DataView };
      if (!Object.hasOwn(types, value.name)) throw new Error('Invalid save archive.');
      return new types[value.name](decode(data, depth + 1));
    }
    case 'array': return data.map(item => decode(item, depth + 1));
    case 'object': return Object.fromEntries(data.map(([key, item]) => [key, decode(item, depth + 1)]));
    default: throw new Error('Invalid save archive.');
  }
}
