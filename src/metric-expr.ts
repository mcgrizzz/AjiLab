// Tiny safe expression evaluator for recipe metrics. No `eval()`, no library —
// just a tokenizer + recursive-descent parser + tree-walking evaluator.
//
// Grammar (loosely):
//   expr   → term  ( ('+'|'-') term )*
//   term   → factor ( ('*'|'/') factor )*
//   factor → number | var | unary '-' factor | '(' expr ')'
//   var    → <ident> ( '.' <ident> )*    -- dotted path; host decides meaning
//   ident  → [A-Za-z_][A-Za-z0-9_]*      -- spaces in names become '_'
//
// Variables resolve via the host-supplied context. The expression layer is
// unit-agnostic and namespace-agnostic — the host decides what each path
// means (`water.g` is an ingredient + unit, `metric.hydration` is a metric
// reference, etc.). Returning a string from `lookup` surfaces a typed error.

export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export interface MetricContext {
  /**
   * Resolve a dotted-path variable reference to a numeric value. The host
   * decides what each path means:
   *   ["water", "g"]              → ingredient water in grams
   *   ["metric", "total_water"]   → previously-computed metric
   * Return `null` for an unknown reference or `string` to surface a specific
   * error (e.g. unit conversion failure). Return a finite number on success.
   */
  lookup(path: string[]): number | string | null;
}

export function evaluateExpression(input: string, ctx: MetricContext): EvalResult {
  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch (e: any) {
    return { ok: false, error: e?.message || "tokenize failed" };
  }
  const parser = new Parser(tokens);
  let ast: Node;
  try {
    ast = parser.parseExpression();
    if (!parser.atEnd()) throw new Error(`unexpected token '${parser.peek().raw}'`);
  } catch (e: any) {
    return { ok: false, error: `syntax error: ${e?.message || "parse failed"}` };
  }
  try {
    const value = evaluate(ast, ctx);
    if (!Number.isFinite(value)) return { ok: false, error: "result is not a finite number" };
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: e?.message || "eval failed" };
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number; raw: string }
  | { kind: "var"; path: string[]; raw: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/"; raw: string }
  | { kind: "lparen"; raw: string }
  | { kind: "rparen"; raw: string };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "(") { out.push({ kind: "lparen", raw: "(" }); i += 1; continue; }
    if (ch === ")") { out.push({ kind: "rparen", raw: ")" }); i += 1; continue; }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      out.push({ kind: "op", op: ch, raw: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i += 1;
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`invalid number '${raw}'`);
      out.push({ kind: "number", value, raw });
      continue;
    }
    if (/[A-Za-z_]/.test(ch) || ch === "%") {
      // Dotted-path variable. Each segment is `[A-Za-z_][A-Za-z0-9_]*`; the
      // bare `%` is only valid as a unit suffix (e.g. for explicit "as
      // percent" intentions in future units). For now `%` segments still
      // surface as identifier segments and the host can reject them.
      const start = i;
      const path: string[] = [];
      while (true) {
        const segStart = i;
        while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i += 1;
        if (i === segStart) {
          if (input[segStart] === "%") { path.push("%"); i += 1; }
          else throw new Error("missing identifier after '.'");
        } else {
          path.push(input.slice(segStart, i));
        }
        if (input[i] !== ".") break;
        i += 1; // consume '.'
      }
      out.push({ kind: "var", path, raw: input.slice(start, i) });
      continue;
    }
    throw new Error(`unexpected character '${ch}'`);
  }
  return out;
}

// ── AST ───────────────────────────────────────────────────────────────────────

type Node =
  | { kind: "num"; value: number }
  | { kind: "var"; path: string[] }
  | { kind: "neg"; inner: Node }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  atEnd(): boolean { return this.pos >= this.tokens.length; }
  peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  parseExpression(): Node {
    let left = this.parseTerm();
    while (!this.atEnd()) {
      const tok = this.peek();
      if (tok.kind !== "op" || (tok.op !== "+" && tok.op !== "-")) break;
      this.advance();
      const right = this.parseTerm();
      left = { kind: "bin", op: tok.op, left, right };
    }
    return left;
  }

  private parseTerm(): Node {
    let left = this.parseFactor();
    while (!this.atEnd()) {
      const tok = this.peek();
      if (tok.kind !== "op" || (tok.op !== "*" && tok.op !== "/")) break;
      this.advance();
      const right = this.parseFactor();
      left = { kind: "bin", op: tok.op, left, right };
    }
    return left;
  }

  private parseFactor(): Node {
    if (this.atEnd()) throw new Error("unexpected end of expression");
    const tok = this.peek();
    if (tok.kind === "op" && tok.op === "-") {
      this.advance();
      return { kind: "neg", inner: this.parseFactor() };
    }
    if (tok.kind === "op" && tok.op === "+") {
      this.advance();
      return this.parseFactor();
    }
    if (tok.kind === "number") {
      this.advance();
      return { kind: "num", value: tok.value };
    }
    if (tok.kind === "var") {
      this.advance();
      return { kind: "var", path: tok.path };
    }
    if (tok.kind === "lparen") {
      this.advance();
      const inner = this.parseExpression();
      if (this.atEnd() || this.peek().kind !== "rparen") throw new Error("expected ')'");
      this.advance();
      return inner;
    }
    throw new Error(`unexpected token '${tok.raw}'`);
  }
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

function evaluate(node: Node, ctx: MetricContext): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "neg":
      return -evaluate(node.inner, ctx);
    case "var": {
      const result = ctx.lookup(node.path);
      if (typeof result === "string") throw new Error(result);
      if (result === null || result === undefined) {
        throw new Error(`unknown reference '${node.path.join(".")}'`);
      }
      return result;
    }
    case "bin": {
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (node.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/":
          if (r === 0) throw new Error("divide by zero");
          return l / r;
      }
    }
  }
}
