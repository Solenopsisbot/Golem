// Shem recursive-descent parser, following the grammar in docs/SHEM.md.
import type { Arg, Block, ConstDecl, EventRef, Expr, File, Loc, Param, ReflexDecl, ScriptDecl, Stmt, TypeRef } from "./ast.ts";
import { lex, ShemSyntaxError, type Token } from "./lexer.ts";

const KEYWORDS = new Set(["use", "const", "let", "script", "reflex", "priority", "on", "when", "if", "else", "for", "of", "while", "repeat", "wait", "until", "timeout", "parallel", "race", "spawn", "try", "catch", "finally", "break", "continue", "return", "fail", "log", "say", "and", "or", "not", "true", "false", "none"]);

export function parse(src: string, name = "main"): File {
  return new Parser(lex(src), src, name).file();
}

/** Parse a standalone expression (used for `shem_eval` snippets and string interpolation). */
export function parseExpr(src: string, loc?: Loc): Expr {
  const p = new Parser(lex(src), src, "expr");
  if (loc) p.offset(loc);
  const e = p.expr();
  p.expect("eof");
  return e;
}

/** Parse a snippet as a script body. */
export function parseSnippet(src: string): File {
  return parse(`script main() {\n${src}\n}`, "main");
}

class Parser {
  private toks: Token[];
  private i = 0;
  private src: string;
  private name: string;
  private pendingDoc: string[] = [];
  constructor(toks: Token[], src: string, name: string) { this.toks = toks; this.src = src; this.name = name; }

  offset(loc: Loc): void {
    for (const t of this.toks) { if (t.loc.line === 1) t.loc = { line: loc.line, col: loc.col + t.loc.col - 1 }; else t.loc = { line: loc.line + t.loc.line - 1, col: t.loc.col }; }
  }

  // ---- token helpers ---------------------------------------------------------------
  private peek(k = 0): Token { return this.toks[Math.min(this.i + k, this.toks.length - 1)]!; }
  private next(): Token { const t = this.peek(); if (t.type !== "eof") this.i++; return t; }
  private at(type: Token["type"], value?: string): boolean { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  private atKw(word: string): boolean { return this.at("ident", word); }
  private atPunct(p: string): boolean { return this.at("punct", p); }
  private accept(type: Token["type"], value?: string): Token | null { return this.at(type, value) ? this.next() : null; }
  private acceptKw(word: string): boolean { return this.accept("ident", word) !== null; }
  private acceptPunct(p: string): boolean { return this.accept("punct", p) !== null; }
  expect(type: Token["type"], value?: string): Token {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) return this.next();
    throw new ShemSyntaxError(`expected ${value ?? type} but found ${describe(t)}`, t.loc);
  }
  private expectPunct(p: string): Token { return this.expect("punct", p); }
  private expectKw(w: string): Token { return this.expect("ident", w); }
  private ident(): string {
    const t = this.peek();
    if (t.type !== "ident" || KEYWORDS.has(t.value)) throw new ShemSyntaxError(`expected a name but found ${describe(t)}`, t.loc);
    return this.next().value;
  }
  private takeDoc(): string { const d = this.pendingDoc.join("\n"); this.pendingDoc = []; return d; }
  private skipDocs(): void { while (this.at("doc")) this.pendingDoc.push(this.next().value); }

  // ---- declarations -----------------------------------------------------------------
  file(): File {
    const f: File = { uses: [], consts: [], scripts: [], reflexes: [], source: this.src, name: this.name };
    for (;;) {
      this.skipDocs();
      const t = this.peek();
      if (t.type === "eof") break;
      if (this.acceptKw("use")) { const s = this.expect("string"); f.uses.push({ path: s.parts!.map((p) => typeof p === "string" ? p : "").join(""), loc: t.loc }); this.acceptPunct(";"); continue; }
      if (this.atKw("const")) { f.consts.push(this.constDecl()); continue; }
      if (this.atKw("script")) { f.scripts.push(this.scriptDecl()); continue; }
      if (this.atKw("reflex")) { f.reflexes.push(this.reflexDecl()); continue; }
      throw new ShemSyntaxError(`expected use, const, script or reflex at top level but found ${describe(t)}`, t.loc);
    }
    return f;
  }

  private constDecl(): ConstDecl {
    const loc = this.expectKw("const").loc;
    const name = this.ident();
    const type = this.acceptPunct(":") ? this.typeRef() : null;
    this.expectPunct("=");
    const value = this.expr();
    this.acceptPunct(";");
    return { kind: "const", name, type, value, loc };
  }

  private scriptDecl(): ScriptDecl {
    const doc = this.takeDoc();
    const loc = this.expectKw("script").loc;
    const name = this.ident();
    this.expectPunct("(");
    const params: Param[] = [];
    if (!this.atPunct(")")) {
      do {
        const ploc = this.peek().loc;
        const pname = this.ident();
        const type = this.acceptPunct(":") ? this.typeRef() : null;
        const def = this.acceptPunct("=") ? this.expr() : null;
        params.push({ name: pname, type, def, loc: ploc });
      } while (this.acceptPunct(","));
    }
    this.expectPunct(")");
    const returnType = this.acceptPunct(":") ? this.typeRef() : null;
    const body = this.block();
    return { kind: "script", name, params, returnType, body, doc, loc };
  }

  private reflexDecl(): ReflexDecl {
    const doc = this.takeDoc();
    const loc = this.expectKw("reflex").loc;
    const name = this.ident();
    let priority: number | null = null;
    if (this.acceptKw("priority")) priority = this.expect("int").num!;
    this.expectKw("on");
    const event = this.eventRef();
    const when = this.acceptKw("when") ? this.expr() : null;
    const body = this.block();
    return { kind: "reflex", name, priority, event, when, body, doc, loc };
  }

  private eventRef(): EventRef {
    const loc = this.peek().loc;
    const name = this.ident();
    const args: string[] = [];
    if (this.acceptPunct("(")) {
      if (!this.atPunct(")")) do { args.push(this.ident()); } while (this.acceptPunct(","));
      this.expectPunct(")");
    }
    return { name, args, loc };
  }

  private typeRef(): TypeRef {
    const loc = this.peek().loc;
    const name = this.ident();
    const args: TypeRef[] = [];
    if (this.acceptPunct("<")) {
      do { args.push(this.typeRef()); } while (this.acceptPunct(","));
      this.expectPunct(">");
    }
    const optional = this.acceptPunct("?");
    return { name, args, optional, loc };
  }

  // ---- statements -------------------------------------------------------------------
  block(): Block {
    const loc = this.expectPunct("{").loc;
    const stmts: Stmt[] = [];
    while (!this.atPunct("}")) {
      if (this.at("eof")) throw new ShemSyntaxError("unexpected end of file inside a block", this.peek().loc);
      this.skipDocs(); this.pendingDoc = [];
      stmts.push(this.stmt());
      this.acceptPunct(";");
    }
    this.expectPunct("}");
    return { stmts, loc };
  }

  private stmt(): Stmt {
    const t = this.peek();
    const loc = t.loc;
    if (t.type === "ident") {
      switch (t.value) {
        case "let": case "const": {
          this.next();
          const name = this.ident();
          const type = this.acceptPunct(":") ? this.typeRef() : null;
          if (this.atKw("spawn")) { /* let x = spawn { } handled below via '=' */ }
          this.expectPunct("=");
          if (this.atKw("spawn")) { this.next(); const body = this.block(); return { kind: "spawn", name, body, loc }; }
          const value = this.expr();
          return { kind: "var", mutable: t.value === "let", name, type, value, loc };
        }
        case "if": return this.ifStmt();
        case "for": {
          this.next(); this.expectPunct("(");
          const a = this.ident();
          let index: string | null = null, item = a;
          if (this.acceptPunct(",")) { index = a; item = this.ident(); }
          this.expectKw("of");
          const iter = this.expr();
          this.expectPunct(")");
          return { kind: "for", index, item, iter, body: this.loopBody(), loc };
        }
        case "while": { this.next(); this.expectPunct("("); const cond = this.expr(); this.expectPunct(")"); return { kind: "while", cond, body: this.loopBody(), loc }; }
        case "repeat": { this.next(); this.expectPunct("("); const count = this.expr(); this.expectPunct(")"); return { kind: "repeat", count, body: this.loopBody(), loc }; }
        case "wait": {
          this.next();
          if (this.acceptKw("until")) {
            const cond = this.expr();
            const timeout = this.acceptKw("timeout") ? this.expr() : null;
            const els = this.acceptKw("else") ? this.block() : null;
            return { kind: "waitUntil", cond, timeout, else: els, loc };
          }
          return { kind: "wait", duration: this.expr(), loc };
        }
        case "timeout": {
          this.next();
          const duration = this.expr();
          const body = this.block();
          const els = this.acceptKw("else") ? this.block() : null;
          return { kind: "timeout", duration, body, else: els, loc };
        }
        case "parallel": case "race": {
          this.next();
          const blocks: Block[] = [];
          while (this.atPunct("{")) blocks.push(this.block());
          if (blocks.length < 2) throw new ShemSyntaxError(`${t.value} needs at least two blocks`, loc);
          return { kind: t.value as "parallel" | "race", blocks, loc };
        }
        case "spawn": { this.next(); return { kind: "spawn", name: null, body: this.block(), loc }; }
        case "try": {
          this.next();
          const body = this.block();
          let catchName: string | null = null, catchBody: Block | null = null, finallyBody: Block | null = null;
          if (this.acceptKw("catch")) {
            if (this.acceptPunct("(")) { catchName = this.ident(); this.expectPunct(")"); }
            catchBody = this.block();
          }
          if (this.acceptKw("finally")) finallyBody = this.block();
          if (!catchBody && !finallyBody) throw new ShemSyntaxError("try needs catch or finally", loc);
          return { kind: "try", body, catchName, catchBody, finallyBody, loc };
        }
        case "on": {
          this.next();
          const event = this.eventRef();
          const when = this.acceptKw("when") ? this.expr() : null;
          return { kind: "on", event, when, body: this.block(), loc };
        }
        case "break": this.next(); return { kind: "break", loc };
        case "continue": this.next(); return { kind: "continue", loc };
        case "return": { this.next(); const value = this.atPunct("}") || this.atPunct(";") ? null : this.expr(); return { kind: "return", value, loc }; }
        case "fail": { this.next(); const value = this.atPunct("}") || this.atPunct(";") ? null : this.expr(); return { kind: "fail", value, loc }; }
        case "log": if (!this.peekIs(1, "punct", "(")) { this.next(); return { kind: "log", value: this.expr(), loc }; } break;
        case "say": if (!this.peekIs(1, "punct", "(")) { this.next(); return { kind: "say", value: this.expr(), loc }; } break;
      }
    }
    // assignment or expression statement
    const expr = this.expr();
    if (this.atPunct("=") || this.atPunct("+=") || this.atPunct("-=")) {
      const op = this.next().value as "=" | "+=" | "-=";
      if (expr.kind !== "ident" && expr.kind !== "member" && expr.kind !== "index") throw new ShemSyntaxError("cannot assign to that", loc);
      return { kind: "assign", target: expr, op, value: this.expr(), loc };
    }
    const timeout = this.acceptKw("timeout") ? this.expr() : null;
    return { kind: "expr", expr, timeout, loc };
  }

  /** Loop bodies: a block, or a single statement wrapped as one. */
  private loopBody(): Block {
    if (this.atPunct("{")) return this.block();
    const loc = this.peek().loc;
    const stmt = this.stmt();
    this.acceptPunct(";");
    return { stmts: [stmt], loc };
  }

  private peekIs(k: number, type: Token["type"], value: string): boolean { const t = this.peek(k); return t.type === type && t.value === value; }

  private ifStmt(): Stmt {
    const loc = this.expectKw("if").loc;
    this.expectPunct("(");
    const cond = this.expr();
    this.expectPunct(")");
    const then: Block | Stmt = this.atPunct("{") ? this.block() : this.stmt();
    this.acceptPunct(";");
    let els: Block | Stmt | null = null;
    if (this.acceptKw("else")) els = this.atKw("if") ? this.ifStmt() : this.atPunct("{") ? this.block() : this.stmt();
    return { kind: "if", cond, then, else: els, loc };
  }

  // ---- expressions --------------------------------------------------------------------
  expr(): Expr { return this.ternary(); }

  private ternary(): Expr {
    const cond = this.orExpr();
    if (this.acceptPunct("?")) {
      const then = this.expr();
      this.expectPunct(":");
      const els = this.expr();
      return { kind: "ternary", cond, then, else: els, loc: cond.loc };
    }
    return cond;
  }
  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.atKw("or") || this.atPunct("||")) { this.next(); const right = this.andExpr(); left = { kind: "binary", op: "or", left, right, loc: left.loc }; }
    return left;
  }
  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.atKw("and") || this.atPunct("&&")) { this.next(); const right = this.notExpr(); left = { kind: "binary", op: "and", left, right, loc: left.loc }; }
    return left;
  }
  private notExpr(): Expr {
    if (this.atKw("not") || this.atPunct("!")) { const loc = this.next().loc; return { kind: "unary", op: "not", operand: this.notExpr(), loc }; }
    return this.cmpExpr();
  }
  private cmpExpr(): Expr {
    const left = this.addExpr();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"] as const) {
      if (this.atPunct(op)) { this.next(); const right = this.addExpr(); return { kind: "binary", op, left, right, loc: left.loc }; }
    }
    return left;
  }
  private addExpr(): Expr {
    let left = this.mulExpr();
    while (this.atPunct("+") || this.atPunct("-")) { const op = this.next().value as "+" | "-"; const right = this.mulExpr(); left = { kind: "binary", op, left, right, loc: left.loc }; }
    return left;
  }
  private mulExpr(): Expr {
    let left = this.unary();
    while (this.atPunct("*") || this.atPunct("/") || this.atPunct("%")) { const op = this.next().value as "*" | "/" | "%"; const right = this.unary(); left = { kind: "binary", op, left, right, loc: left.loc }; }
    return left;
  }
  private unary(): Expr {
    if (this.atPunct("-")) { const loc = this.next().loc; return { kind: "unary", op: "-", operand: this.unary(), loc }; }
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.acceptPunct(".")) { const name = this.ident(); e = { kind: "member", obj: e, name, loc: e.loc }; continue; }
      if (this.atPunct("(")) { const args = this.args(); e = { kind: "call", callee: e, args, loc: e.loc }; continue; }
      if (this.acceptPunct("[")) { const index = this.expr(); this.expectPunct("]"); e = { kind: "index", obj: e, index, loc: e.loc }; continue; }
      return e;
    }
  }
  private args(): Arg[] {
    this.expectPunct("(");
    const args: Arg[] = [];
    if (!this.atPunct(")")) {
      do {
        const loc = this.peek().loc;
        // named argument: ident ':' expr   (but not 'a ? b : c' — the ternary is handled after)
        if (this.peek().type === "ident" && this.peekIs(1, "punct", ":")) {   // keywords are fine as labels (timeout: 5s)
          const name = this.next().value; this.next();
          args.push({ name, value: this.expr(), loc });
        } else args.push({ name: null, value: this.expr(), loc });
      } while (this.acceptPunct(","));
    }
    this.expectPunct(")");
    return args;
  }
  private primary(): Expr {
    const t = this.peek();
    const loc = t.loc;
    switch (t.type) {
      case "int": this.next(); return { kind: "int", value: t.num!, loc };
      case "float": this.next(); return { kind: "float", value: t.num!, loc };
      case "dur": this.next(); return { kind: "dur", ms: t.num!, loc };
      case "string": {
        this.next();
        const parts: (string | Expr)[] = t.parts!.map((p) => typeof p === "string" ? p : parseExpr(p.src, p.loc));
        return { kind: "string", parts, loc };
      }
      case "ident": {
        if (t.value === "true" || t.value === "false") { this.next(); return { kind: "bool", value: t.value === "true", loc }; }
        if (t.value === "none") { this.next(); return { kind: "none", loc }; }
        if (KEYWORDS.has(t.value) && t.value !== "say" && t.value !== "log") throw new ShemSyntaxError(`unexpected keyword ${t.value}`, loc);
        this.next();
        return { kind: "ident", name: t.value, loc };
      }
      case "punct": {
        if (t.value === "(") {
          // lambda: (a, b) => ...   |  tuple: (x, y, z)  |  grouping: (expr)
          if (this.isLambdaAhead()) return this.lambda();
          this.next();
          const first = this.expr();
          if (this.acceptPunct(",")) {
            const second = this.expr(); this.expectPunct(",");
            const third = this.expr(); this.expectPunct(")");
            return { kind: "tuple", items: [first, second, third], loc };
          }
          this.expectPunct(")");
          return first;
        }
        if (t.value === "[") {
          this.next();
          const items: Expr[] = [];
          if (!this.atPunct("]")) do { if (this.atPunct("]")) break; items.push(this.expr()); } while (this.acceptPunct(","));
          this.expectPunct("]");
          return { kind: "list", items, loc };
        }
        if (t.value === "{") {
          this.next();
          const entries: { key: string; value: Expr }[] = [];
          if (!this.atPunct("}")) do {
            if (this.atPunct("}")) break;
            const k = this.peek();
            let key: string;
            if (k.type === "string") { this.next(); key = k.parts!.map((p) => typeof p === "string" ? p : "").join(""); }
            else key = this.ident();
            this.expectPunct(":");
            entries.push({ key, value: this.expr() });
          } while (this.acceptPunct(","));
          this.expectPunct("}");
          return { kind: "map", entries, loc };
        }
        break;
      }
      default: break;
    }
    throw new ShemSyntaxError(`unexpected ${describe(t)}`, loc);
  }
  private isLambdaAhead(): boolean {
    // '(' [ident {',' ident}] ')' '=>'
    let k = 1;
    if (this.peekIs(k, "punct", ")")) return this.peekIs(k + 1, "punct", "=>");
    for (;;) {
      if (this.peek(k).type !== "ident") return false;
      k++;
      if (this.peekIs(k, "punct", ",")) { k++; continue; }
      if (this.peekIs(k, "punct", ")")) return this.peekIs(k + 1, "punct", "=>");
      return false;
    }
  }
  private lambda(): Expr {
    const loc = this.expectPunct("(").loc;
    const params: string[] = [];
    if (!this.atPunct(")")) do { params.push(this.ident()); } while (this.acceptPunct(","));
    this.expectPunct(")");
    this.expectPunct("=>");
    const body = this.atPunct("{") ? this.block() : this.expr();
    return { kind: "lambda", params, body, loc };
  }
}

function describe(t: Token): string {
  switch (t.type) {
    case "eof": return "end of file";
    case "string": return "a string";
    case "punct": return `'${t.value}'`;
    default: return `'${t.value}'`;
  }
}
