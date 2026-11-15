export type BencodeValue =
  | number
  | Uint8Array
  | BencodeValue[]
  | { [key: string]: BencodeValue };

export type BencodeEncodable =
  | number
  | string
  | Uint8Array
  | BencodeEncodable[]
  | { [key: string]: BencodeEncodable };

export interface DecodeResult {
  value: BencodeValue;
  nextOffset: number;
  rawInfoSlice?: Uint8Array;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function utf8ToBytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * 解码 Bencode 字节流，并在顶层字典包含 "info" 键时精确记录其原始字节切片（用于计算 SHA-1 info_hash）。
 */
export function decodeBencode(
  buffer: Uint8Array,
  offset = 0,
  isRootDict = true,
): DecodeResult {
  if (offset >= buffer.byteLength) {
    throw new Error("Bencode: unexpected EOF");
  }

  const tag = buffer[offset];

  // Integer: i<number>e
  if (tag === 0x69 /* 'i' */) {
    const endIdx = buffer.indexOf(0x65 /* 'e' */, offset + 1);
    if (endIdx === -1) {
      throw new Error("Bencode: unterminated integer");
    }
    const numStr = bytesToUtf8(buffer.subarray(offset + 1, endIdx));
    const num = Number(numStr);
    if (!Number.isFinite(num)) {
      throw new Error(`Bencode: invalid integer "${numStr}"`);
    }
    return { value: num, nextOffset: endIdx + 1 };
  }

  // List: l<items>e
  if (tag === 0x6c /* 'l' */) {
    const list: BencodeValue[] = [];
    let cursor = offset + 1;
    while (cursor < buffer.byteLength && buffer[cursor] !== 0x65 /* 'e' */) {
      const item = decodeBencode(buffer, cursor, false);
      list.push(item.value);
      cursor = item.nextOffset;
    }
    if (cursor >= buffer.byteLength) {
      throw new Error("Bencode: unterminated list");
    }
    return { value: list, nextOffset: cursor + 1 };
  }

  // Dictionary: d<key><value>...e
  if (tag === 0x64 /* 'd' */) {
    const dict: { [key: string]: BencodeValue } = {};
    let cursor = offset + 1;
    let rawInfoSlice: Uint8Array | undefined;

    while (cursor < buffer.byteLength && buffer[cursor] !== 0x65 /* 'e' */) {
      const keyRes = decodeBencode(buffer, cursor, false);
      if (!(keyRes.value instanceof Uint8Array)) {
        throw new Error("Bencode: dictionary key must be a byte string");
      }
      const key = bytesToUtf8(keyRes.value);
      const valStart = keyRes.nextOffset;
      const valRes = decodeBencode(buffer, valStart, false);
      dict[key] = valRes.value;
      if (isRootDict && key === "info") {
        rawInfoSlice = buffer.subarray(valStart, valRes.nextOffset);
      }
      cursor = valRes.nextOffset;
    }
    if (cursor >= buffer.byteLength) {
      throw new Error("Bencode: unterminated dictionary");
    }
    return { value: dict, nextOffset: cursor + 1, rawInfoSlice };
  }

  // Byte string: <length>:<bytes>
  if (tag >= 0x30 && tag <= 0x39 /* '0'..'9' */) {
    const colonIdx = buffer.indexOf(0x3a /* ':' */, offset);
    if (colonIdx === -1) {
      throw new Error("Bencode: missing colon in byte string");
    }
    const lenStr = bytesToUtf8(buffer.subarray(offset, colonIdx));
    const len = Number(lenStr);
    if (!Number.isInteger(len) || len < 0) {
      throw new Error(`Bencode: invalid string length "${lenStr}"`);
    }
    const start = colonIdx + 1;
    const end = start + len;
    if (end > buffer.byteLength) {
      throw new Error("Bencode: byte string exceeds buffer");
    }
    return {
      value: buffer.subarray(start, end),
      nextOffset: end,
    };
  }

  throw new Error(`Bencode: unexpected byte 0x${tag.toString(16)} at offset ${offset}`);
}

/**
 * 将 BencodeValue 编码回字节数组。
 */
export function encodeBencode(value: BencodeEncodable): Uint8Array {
  const chunks: Uint8Array[] = [];

  function write(val: BencodeEncodable): void {
    if (typeof val === "number") {
      chunks.push(utf8ToBytes(`i${Math.trunc(val)}e`));
      return;
    }
    if (typeof val === "string") {
      const bytes = utf8ToBytes(val);
      chunks.push(utf8ToBytes(`${bytes.byteLength}:`));
      chunks.push(bytes);
      return;
    }
    if (val instanceof Uint8Array) {
      chunks.push(utf8ToBytes(`${val.byteLength}:`));
      chunks.push(val);
      return;
    }
    if (Array.isArray(val)) {
      chunks.push(utf8ToBytes("l"));
      for (const item of val) {
        write(item);
      }
      chunks.push(utf8ToBytes("e"));
      return;
    }
    if (val && typeof val === "object") {
      chunks.push(utf8ToBytes("d"));
      const keys = Object.keys(val).sort();
      for (const k of keys) {
        write(k);
        write(val[k]);
      }
      chunks.push(utf8ToBytes("e"));
      return;
    }
  }

  write(value);
  const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
