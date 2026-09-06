// Shem abstract syntax. See docs/SHEM.md for the grammar this mirrors.

export interface Loc { line: number; col: number }

export interface File {
  uses: { path: string; loc: Loc }[];
  consts: ConstDecl[];
  scripts: ScriptDecl[];
  reflexes: ReflexDecl[];
  source: string;
  name: string;            // file name without extension, for the default entry point
}

export interface TypeRef { name: string; args: TypeRef[]; optional: boolean; loc: Loc }
export interface Param { name: string; type: TypeRef | null; def: Expr | null; loc: Loc }

export interface ConstDecl { kind: "const"; name: string; type: TypeRef | null; value: Expr; loc: Loc }
export interface ScriptDecl { kind: "script"; name: string; params: Param[]; returnType: TypeRef | null; body: Block; doc: string; loc: Loc }
export interface ReflexDecl { kind: "reflex"; name: string; priority: number | null; event: EventRef; when: Expr | null; body: Block; doc: string; loc: Loc }
export interface EventRef { name: string; args: string[]; loc: Loc }

export interface Block { stmts: Stmt[]; loc: Loc }

export type Stmt =
  | { kind: "var"; mutable: boolean; name: string; type: TypeRef | null; value: Expr; loc: Loc }
  | { kind: "assign"; target: Expr; op: "=" | "+=" | "-="; value: Expr; loc: Loc }
  | { kind: "if"; cond: Expr; then: Block | Stmt; else: Block | Stmt | null; loc: Loc }
  | { kind: "for"; index: string | null; item: string; iter: Expr; body: Block; loc: Loc }
  | { kind: "while"; cond: Expr; body: Block; loc: Loc }
  | { kind: "repeat"; count: Expr; body: Block; loc: Loc }
  | { kind: "wait"; duration: Expr; loc: Loc }
  | { kind: "waitUntil"; cond: Expr; timeout: Expr | null; else: Block | null; loc: Loc }
  | { kind: "timeout"; duration: Expr; body: Block; else: Block | null; loc: Loc }
  | { kind: "parallel"; blocks: Block[]; loc: Loc }
  | { kind: "race"; blocks: Block[]; loc: Loc }
  | { kind: "spawn"; name: string | null; body: Block; loc: Loc }
  | { kind: "try"; body: Block; catchName: string | null; catchBody: Block | null; finallyBody: Block | null; loc: Loc }
  | { kind: "on"; event: EventRef; when: Expr | null; body: Block; loc: Loc }
  | { kind: "break"; loc: Loc }
  | { kind: "continue"; loc: Loc }
  | { kind: "return"; value: Expr | null; loc: Loc }
  | { kind: "fail"; value: Expr | null; loc: Loc }
  | { kind: "log"; value: Expr; loc: Loc }
  | { kind: "say"; value: Expr; loc: Loc }
  | { kind: "expr"; expr: Expr; timeout: Expr | null; loc: Loc };

export type Expr =
  | { kind: "int"; value: number; loc: Loc }
  | { kind: "float"; value: number; loc: Loc }
  | { kind: "bool"; value: boolean; loc: Loc }
  | { kind: "none"; loc: Loc }
  | { kind: "dur"; ms: number; loc: Loc }
  | { kind: "string"; parts: (string | Expr)[]; loc: Loc }
  | { kind: "ident"; name: string; loc: Loc }
  | { kind: "tuple"; items: [Expr, Expr, Expr]; loc: Loc }
  | { kind: "list"; items: Expr[]; loc: Loc }
  | { kind: "map"; entries: { key: string; value: Expr }[]; loc: Loc }
  | { kind: "lambda"; params: string[]; body: Expr | Block; loc: Loc }
  | { kind: "unary"; op: "-" | "not"; operand: Expr; loc: Loc }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; loc: Loc }
  | { kind: "ternary"; cond: Expr; then: Expr; else: Expr; loc: Loc }
  | { kind: "call"; callee: Expr; args: Arg[]; loc: Loc }
  | { kind: "member"; obj: Expr; name: string; loc: Loc }
  | { kind: "index"; obj: Expr; index: Expr; loc: Loc };

export type BinaryOp = "or" | "and" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";
export interface Arg { name: string | null; value: Expr; loc: Loc }

export function fmtLoc(l: Loc): string { return `${l.line}:${l.col}`; }
