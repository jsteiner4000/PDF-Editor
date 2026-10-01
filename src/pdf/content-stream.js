/**
 * Tokenizer, Parser und Serialisierer für PDF-Content-Streams (Operatoren mit Operanden).
 */

const WHITESPACE = new Uint8Array(256);

[0, 9, 10, 12, 13, 32].forEach((r) => {
  WHITESPACE[r] = 1;
});

const DELIMITERS = new Uint8Array(256);

'()<>[]{}/%'.split('').forEach((r) => {
  DELIMITERS[r.charCodeAt(0)] = 1;
});

export class NameToken {
  constructor(name) {
    this.v = name;
  }
}

export class StringToken {
  constructor(bytes, hex) {
    this.bytes = bytes;
    this.hex = !!hex;
  }
}

class DictToken {
  constructor(map) {
    this.m = map;
  }
  get(key) {
    return this.m.get(key);
  }
}

export class ContentOp {
  constructor(op, args, start, end) {
    this.op = op;
    this.args = args;
    this.s = start;
    this.e = end;
    this.raw = null;
  }
}

export function bytesToLatin1(bytes) {
  let str = '';
  for (let k = 0; k < bytes.length; k += 32768)
    str += String.fromCharCode.apply(null, bytes.subarray(k, k + 32768));
  return str;
}

export function latin1ToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let k = 0; k < str.length; k++) bytes[k] = str.charCodeAt(k) & 255;
  return bytes;
}

export function parseContentStream(src) {
  const ops = [];
  const len = src.length;
  let pos = 0;
  let operands = [];
  let opStart = -1;
  const codeAt = (at) => src.charCodeAt(at);
  const skipSpace = () => {
    while (true) {
      while (pos < len && WHITESPACE[codeAt(pos)]) pos++;
      if (pos < len && codeAt(pos) === 37) {
        while (pos < len && codeAt(pos) !== 10 && codeAt(pos) !== 13) pos++;
        continue;
      }
      break;
    }
  };
  const readObject = () => {
    const ch = src[pos];
    if (ch === '/') {
      let nameEnd = pos + 1;
      while (nameEnd < len && !WHITESPACE[codeAt(nameEnd)] && !DELIMITERS[codeAt(nameEnd)]) nameEnd++;
      const rawName = src.slice(pos + 1, nameEnd);
      pos = nameEnd;
      return new NameToken(
        rawName.replace(/#([0-9a-fA-F]{2})/g, (d, I) => String.fromCharCode(parseInt(I, 16))),
      );
    }
    if (ch === '(') {
      let depth = 1;
      let at = pos + 1;
      const bytes = [];
      while (at < len && depth > 0) {
        const c = src[at];
        if (c === '\\') {
          const next = src[at + 1];
          const escaped = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[next];
          if (escaped !== undefined) {
            bytes.push(escaped);
            at += 2;
          } else if (next >= '0' && next <= '7') {
            let k = at + 1;
            let octal = '';
            while (k < len && octal.length < 3 && src[k] >= '0' && src[k] <= '7') octal += src[k++];
            bytes.push(parseInt(octal, 8) & 255);
            at = k;
          } else if (next === '\r') at += src[at + 2] === '\n' ? 3 : 2;
          else if (next === '\n') at += 2;
          else at += 1;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')' && (depth--, depth === 0)) {
          at++;
          break;
        }
        bytes.push(src.charCodeAt(at) & 255);
        at++;
      }
      pos = at;
      return new StringToken(Uint8Array.from(bytes), false);
    }
    if (ch === '<' && src[pos + 1] === '<') {
      pos += 2;
      const dict = new Map();
      while (true) {
        skipSpace();
        if (pos >= len) break;
        if (src[pos] === '>' && src[pos + 1] === '>') {
          pos += 2;
          break;
        }
        const key = readObject();
        skipSpace();
        const value = readObject();
        if (key instanceof NameToken) dict.set(key.v, value);
      }
      return new DictToken(dict);
    }
    if (ch === '<') {
      let close = pos + 1;
      while (close < len && src[close] !== '>') close++;
      let hex = src.slice(pos + 1, close).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
      pos = close + 1;
      return new StringToken(bytes, true);
    }
    if (ch === '[') {
      pos++;
      const items = [];
      while (true) {
        skipSpace();
        if (pos >= len) break;
        if (src[pos] === ']') {
          pos++;
          break;
        }
        const item = readObject();
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (ch === ']' || ch === '>' || ch === ')' || ch === '{' || ch === '}') {
      pos++;
      return null;
    }
    let end = pos;
    while (end < len && !WHITESPACE[codeAt(end)] && !DELIMITERS[codeAt(end)]) end++;
    if (end === pos) {
      pos++;
      return null;
    }
    const word = src.slice(pos, end);
    pos = end;
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || (/^[+-]?\d*\.\d*$/.test(word) && word !== '.')
      ? parseFloat(word) || 0
      : word === 'true'
        ? true
        : word === 'false'
          ? false
          : word === 'null'
            ? null
            : { kw: word };
  };
  while (true) {
    skipSpace();
    if (pos >= len) break;
    if (opStart < 0) opStart = pos;
    const token = readObject();
    if (token && token.kw !== undefined) {
      const keyword = token.kw;
      if (keyword === 'BI') {
        const inlineDict = new Map();
        while (true) {
          skipSpace();
          if (pos >= len) break;
          const before = pos;
          const key = readObject();
          if (key && key.kw === 'ID') break;
          skipSpace();
          const value = readObject();
          if (key instanceof NameToken) inlineDict.set(key.v, value);
          if (pos === before) break;
        }
        pos++;
        const dataStart = pos;
        const declaredLength = inlineDict.get('L') || inlineDict.get('Length');
        let dataEnd = -1;
        if (typeof declaredLength == 'number' && declaredLength > 0) dataEnd = dataStart + declaredLength;
        else {
          let scan = dataStart;
          while (scan < len - 1) {
            if (
              src[scan] === 'E' &&
              src[scan + 1] === 'I' &&
              (scan === dataStart || WHITESPACE[codeAt(scan - 1)]) &&
              (scan + 2 >= len || WHITESPACE[codeAt(scan + 2)])
            ) {
              dataEnd = scan - (WHITESPACE[codeAt(scan - 1)] ? 1 : 0);
              break;
            }
            scan++;
          }
          if (dataEnd < 0) dataEnd = len;
        }
        let endPos = dataEnd;
        while (endPos < len && !(src[endPos] === 'E' && src[endPos + 1] === 'I')) endPos++;
        pos = Math.min(len, endPos + 2);
        const op = new ContentOp(
          'BI',
          [new DictToken(inlineDict), src.slice(dataStart, dataEnd)],
          opStart,
          pos,
        );
        ops.push(op);
        operands = [];
        opStart = -1;
        continue;
      }
      ops.push(new ContentOp(keyword, operands, opStart, pos));
      operands = [];
      opStart = -1;
    } else if (token !== undefined) operands.push(token);
  }
  return ops;
}

export const formatNumber = (n) => {
  if (!isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let str = n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  if (str === '-0') str = '0';
  return str;
};

export const bytesToHexString = (bytes) => {
  let str = '<';
  for (const b of bytes) str += b.toString(16).padStart(2, '0');
  return str + '>';
};

function serializeOperand(value) {
  return typeof value == 'number'
    ? formatNumber(value)
    : value instanceof NameToken
      ? '/' +
        value.v.replace(
          /[^\x21-\x7e]|[#()<>[\]{}/%]/g,
          (e) => '#' + e.charCodeAt(0).toString(16).padStart(2, '0'),
        )
      : value instanceof StringToken
        ? bytesToHexString(value.bytes)
        : Array.isArray(value)
          ? '[' + value.map(serializeOperand).join(' ') + ']'
          : value instanceof DictToken
            ? '<<' + [...value.m].map(([e, t]) => '/' + e + ' ' + serializeOperand(t)).join(' ') + '>>'
            : value === true
              ? 'true'
              : value === false
                ? 'false'
                : value === null
                  ? 'null'
                  : value && value.kw
                    ? value.kw
                    : '';
}

function serializeOp(op, args) {
  return (args && args.length ? args.map(serializeOperand).join(' ') + ' ' : '') + op;
}

export function serializeOps(ops, src) {
  const parts = [];
  for (const op of ops)
    if (!op.deleted) {
      if (op.raw != null) parts.push(op.raw);
      else if (!op.dirty && src != null && op.s != null && op.e != null) parts.push(src.slice(op.s, op.e));
      else if (op.op === 'BI')
        parts.push(
          'BI ' +
            [...op.args[0].m].map(([n, a]) => '/' + n + ' ' + serializeOperand(a)).join(' ') +
            ' ID ' +
            op.args[1] +
            ' EI',
        );
      else parts.push(serializeOp(op.op, op.args));
    }
  return parts.join('\n');
}

export const newOp = (name, ...args) => {
  const op = new ContentOp(name, args, null, null);
  op.dirty = true;
  return op;
};
