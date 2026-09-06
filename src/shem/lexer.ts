// Shem lexer. Produces a flat token list; string interpolation is kept as parts (literal text and
// embedded expression source) for the parser to recurse into.
import type { Loc } from "./ast.ts";

export type TokenType = "ident" | "int" | "float" | "string" | "dur" | "punct" | "doc" | "eof";
export interface Token {
  type: TokenType;
  value: string;                       // ident name, punct text, doc text, numeric source
  num?: number;                        // int/float/dur (ms) value
  parts?: (string | { src: string; loc: Loc })[];   // string parts
  loc: Loc;
}

export class ShemSyntaxError extends Error {
  readonly loc: Loc;
  constructor(message: string, loc: Loc) {
    super(`${loc.line}:${loc.col}: ${message}`);
    this.name = "ShemSyntaxError";
    this.loc = loc;
  }
}

const PUNCTS = ["=>", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "(", ")", "{", "}", "[", "]", ",", ":", ".", ";", "<", ">", "=", "+", "-", "*", "/", "%", "!", "?"];
const DUR_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, t: 50 };

export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, col = 1;
  const loc = (): Loc => ({ line, col });
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } };
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(); continue; }
    // comments
    if (c === "/" && src[i + 1] === "/") {
      const start = loc();
      const isDoc = src[i + 2] === "/";
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      const text = src.slice(i + (isDoc ? 3 : 2), j).trim();
      adv(j - i);
      if (isDoc) out.push({ type: "doc", value: text, loc: start });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = loc();
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new ShemSyntaxError("unterminated block comment", start);
      adv(end + 2 - i);
      continue;
    }
    // strings
    if (c === '"' || c === "'") {
      const start = loc();
      const quote = c;
      adv();
      const parts: Token["parts"] = [];
      let buf = "";
      for (;;) {
        if (i >= src.length) throw new ShemSyntaxError("unterminated string", start);
        const ch = src[i]!;
        if (ch === quote) { adv(); break; }
        if (ch === "\\") {
          const n = src[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\", $: "$", "{": "{" };
          if (n !== undefined && n in map) { buf += map[n]; adv(2); continue; }
          throw new ShemSyntaxError(`bad escape \\${n ?? ""}`, loc());
        }
        if (ch === "$" && src[i + 1] === "{") {
          if (buf) { parts.push(buf); buf = ""; }
          adv(2);
          const exprLoc = loc();
          let depth = 1, j = i;
          while (j < src.length && depth > 0) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; if (depth > 0) j++; }
          if (depth !== 0) throw new ShemSyntaxError("unterminated ${ in string", exprLoc);
          parts.push({ src: src.slice(i, j), loc: exprLoc });
          adv(j - i + 1);
          continue;
        }
        buf += ch; adv();
      }
      if (buf || parts.length === 0) parts.push(buf);
      out.push({ type: "string", value: "", parts, loc: start });
      continue;
    }
    // numbers and durations
    if (/[0-9]/.test(c)) {
      const start = loc();
      let j = i;
      while (j < src.length && /[0-9_]/.test(src[j]!)) j++;
      let isFloat = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) { isFloat = true; j++; while (j < src.length && /[0-9_]/.test(src[j]!)) j++; }
      const numSrc = src.slice(i, j).replace(/_/g, "");
      // duration suffix?
      const unitMatch = /^(ms|s|m|h|t)(?![A-Za-z0-9_])/.exec(src.slice(j, j + 3));
      if (unitMatch) {
        const unit = unitMatch[1]!;
        const ms = Number(numSrc) * DUR_UNITS[unit]!;
        adv(j - i + unit.length);
        out.push({ type: "dur", value: numSrc + unit, num: ms, loc: start });
        continue;
      }
      if (/[A-Za-z_]/.test(src[j] ?? "")) throw new ShemSyntaxError(`bad number suffix in ${src.slice(i, j + 1)}`, start);
      adv(j - i);
      out.push({ type: isFloat ? "float" : "int", value: numSrc, num: Number(numSrc), loc: start });
      continue;
    }
    // identifiers / keywords
    if (isIdStart(c)) {
      const start = loc();
      let j = i;
      while (j < src.length && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      adv(j - i);
      out.push({ type: "ident", value: word, loc: start });
      continue;
    }
    // punctuation
    const start = loc();
    const p = PUNCTS.find((s) => src.startsWith(s, i));
    if (!p) throw new ShemSyntaxError(`unexpected character ${JSON.stringify(c)}`, start);
    adv(p.length);
    out.push({ type: "punct", value: p, loc: start });
  }
  out.push({ type: "eof", value: "", loc: loc() });
  return out;
}
