// ============================================================
// analysis/raster/map-algebra.ts — 栅格代数（Map Algebra）
// ============================================================
//
// 对一个或多个栅格（DEMData）做像元级数学运算，输出新的 DEMData。
// 概念来自 Dana Tomlin 的 Map Algebra 理论（1990），是 ArcGIS Spatial
// Analyst 的核心模型。
//
// 本实现提供两层 API：
//
// 1. 命名操作（类型安全，推荐）：
//    - localAdd / localSub / localMul / localDiv / localPow
//    - localMin / localMax / localMean / localSum
//    - localAbs / localSqrt / localLog / localExp
//    - localClamp
//    - localCondition (if-else)
//    - localCombine (自定义 per-cell 函数)
//
// 2. 表达式求值（灵活）：
//    - evaluate(expression, rasterMap)
//    - 解析器支持：+ - * / ^ ( ) 数字 标识符 函数调用
//    - 标识符在 rasterMap 中查找对应 DEMData
//    - 内置函数：abs, sqrt, log, exp, min, max, pow, sin, cos, tan
//
// 所有栅格必须同尺寸（rows, cols）；NaN 通过传播（任何 NaN 参与
// 运算结果都是 NaN），与 GIS 软件的 NO_DATA 约定一致。
// ============================================================

import type { DEMData } from './index.ts';

// ─── 辅助：构造输出 DEM ────────────────────────────────────

function sameShape(a: DEMData, b: DEMData): boolean {
    return a.rows === b.rows && a.cols === b.cols;
}

function newDemFrom(ref: DEMData, rows: number, cols: number): number[][] {
    void ref;
    const out: number[][] = new Array(rows);
    for (let r = 0; r < rows; r++) {
        out[r] = new Array(cols);
    }
    return out;
}

function wrap(ref: DEMData, values: number[][]): DEMData {
    return {
        values,
        rows: ref.rows,
        cols: ref.cols,
        bbox: ref.bbox,
        cellSizeM: ref.cellSizeM,
    };
}

// ─── 一元操作 ──────────────────────────────────────────────

/**
 * 对单个栅格应用 per-cell 变换函数。
 */
function mapUnary(dem: DEMData, fn: (v: number) => number): DEMData {
    const out = newDemFrom(dem, dem.rows, dem.cols);
    for (let r = 0; r < dem.rows; r++) {
        for (let c = 0; c < dem.cols; c++) {
            const v = dem.values[r]![c]!;
            out[r][c] = Number.isNaN(v) ? NaN : fn(v);
        }
    }
    return wrap(dem, out);
}

export function localAbs(a: DEMData): DEMData { return mapUnary(a, Math.abs); }
export function localSqrt(a: DEMData): DEMData { return mapUnary(a, Math.sqrt); }
export function localLog(a: DEMData): DEMData { return mapUnary(a, Math.log); }
export function localExp(a: DEMData): DEMData { return mapUnary(a, Math.exp); }

/** 把每个 cell 钳位到 [min, max]。 */
export function localClamp(a: DEMData, lo: number, hi: number): DEMData {
    return mapUnary(a, (v) => (v < lo ? lo : v > hi ? hi : v));
}

// ─── 二元操作 ──────────────────────────────────────────────

/**
 * 对两个栅格或栅格+标量应用 per-cell 二元函数。
 * 两个参数都可以是 DEMData 或 number。
 */
function mapBinary(
    a: DEMData | number,
    b: DEMData | number,
    fn: (x: number, y: number) => number,
): DEMData {
    if (typeof a === 'number' && typeof b === 'number') {
        throw new Error('mapBinary: 至少一个参数必须是 DEMData');
    }
    const ref = typeof a === 'object' ? a : (b as DEMData);
    const rows = ref.rows;
    const cols = ref.cols;
    if (typeof a === 'object' && typeof b === 'object' && !sameShape(a, b)) {
        throw new Error(`mapBinary: 形状不匹配 ${a.rows}x${a.cols} vs ${b.rows}x${b.cols}`);
    }
    const out = newDemFrom(ref, rows, cols);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const av = typeof a === 'number' ? a : a.values[r]![c]!;
            const bv = typeof b === 'number' ? b : b.values[r]![c]!;
            out[r][c] = Number.isNaN(av) || Number.isNaN(bv) ? NaN : fn(av, bv);
        }
    }
    return wrap(ref, out);
}

export function localAdd(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, (x, y) => x + y);
}
export function localSub(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, (x, y) => x - y);
}
export function localMul(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, (x, y) => x * y);
}
export function localDiv(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, (x, y) => (y === 0 ? NaN : x / y));
}
export function localPow(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, Math.pow);
}
export function localMin(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, Math.min);
}
export function localMax(a: DEMData | number, b: DEMData | number): DEMData {
    return mapBinary(a, b, Math.max);
}

// ─── 多元操作 ──────────────────────────────────────────────

/**
 * 对 N 个栅格逐像元求和（按"任一 NaN → 输出 NaN"规则）。
 */
export function localSum(rasters: readonly DEMData[]): DEMData {
    if (rasters.length === 0) {
        throw new Error('localSum: 至少需要一个栅格');
    }
    const ref = rasters[0];
    for (let i = 1; i < rasters.length; i++) {
        if (!sameShape(ref, rasters[i])) {
            throw new Error(`localSum: 第 ${i} 个栅格形状与参考不匹配`);
        }
    }
    const out = newDemFrom(ref, ref.rows, ref.cols);
    for (let r = 0; r < ref.rows; r++) {
        for (let c = 0; c < ref.cols; c++) {
            let s = 0;
            let hasNaN = false;
            for (let i = 0; i < rasters.length; i++) {
                const v = rasters[i].values[r]![c]!;
                if (Number.isNaN(v)) { hasNaN = true; break; }
                s += v;
            }
            out[r][c] = hasNaN ? NaN : s;
        }
    }
    return wrap(ref, out);
}

/** 对 N 个栅格逐像元求算术平均。 */
export function localMean(rasters: readonly DEMData[]): DEMData {
    return localDiv(localSum(rasters), rasters.length);
}

/**
 * 条件函数：if (cond > 0) then trueVal else falseVal。
 *
 * 如 `localCondition(elevationMap, 1000, 0, 1)`：高程 > 0（这里 cond 是高程本身）
 * 返回 1，否则返回 0。典型用法是先 localSub 得到判别值再用 localCondition。
 */
export function localCondition(
    cond: DEMData,
    trueVal: DEMData | number,
    falseVal: DEMData | number,
): DEMData {
    const ref = cond;
    const out = newDemFrom(ref, ref.rows, ref.cols);
    for (let r = 0; r < ref.rows; r++) {
        for (let c = 0; c < ref.cols; c++) {
            const cv = cond.values[r]![c]!;
            if (Number.isNaN(cv)) {
                out[r][c] = NaN;
                continue;
            }
            if (cv > 0) {
                out[r][c] = typeof trueVal === 'number' ? trueVal : trueVal.values[r]![c]!;
            } else {
                out[r][c] = typeof falseVal === 'number' ? falseVal : falseVal.values[r]![c]!;
            }
        }
    }
    return wrap(ref, out);
}

/**
 * 自定义 per-cell 函数：对 N 个输入栅格同位置的值应用用户函数。
 */
export function localCombine(
    rasters: readonly DEMData[],
    fn: (values: number[]) => number,
): DEMData {
    if (rasters.length === 0) {
        throw new Error('localCombine: 至少需要一个栅格');
    }
    const ref = rasters[0];
    for (let i = 1; i < rasters.length; i++) {
        if (!sameShape(ref, rasters[i])) {
            throw new Error(`localCombine: 第 ${i} 个栅格形状不匹配`);
        }
    }
    const out = newDemFrom(ref, ref.rows, ref.cols);
    const scratch = new Array<number>(rasters.length);
    for (let r = 0; r < ref.rows; r++) {
        for (let c = 0; c < ref.cols; c++) {
            let hasNaN = false;
            for (let i = 0; i < rasters.length; i++) {
                const v = rasters[i].values[r]![c]!;
                if (Number.isNaN(v)) { hasNaN = true; break; }
                scratch[i] = v;
            }
            out[r][c] = hasNaN ? NaN : fn(scratch);
        }
    }
    return wrap(ref, out);
}

// ─── 表达式求值（简易 AST 解析器）───────────────────────────

/**
 * 把数学表达式 + 变量映射求值为 DEMData。
 *
 * 支持：
 * - 二元运算符：+ - * / ^
 * - 一元负号：-x
 * - 括号：( )
 * - 数字字面量（浮点数，不支持科学计数）
 * - 标识符：从 rasterMap 查找对应 DEMData
 * - 内置函数：abs, sqrt, log, exp, min, max, pow, sin, cos, tan
 *   （min/max/pow 二参；其余一参）
 *
 * 每个像元独立求值（所有参与运算的栅格必须同尺寸）。
 *
 * @example
 * evaluate("(a + b) * 0.5", { a: dem1, b: dem2 });   // 平均
 * evaluate("sqrt(a*a + b*b)", { a: dx, b: dy });     // 梯度幅度
 */
export function evaluate(
    expression: string,
    rasterMap: Readonly<Record<string, DEMData>>,
): DEMData {
    const tokens = tokenize(expression);
    const ast = parse(tokens);

    // 确定参考尺寸：第一个在 rasterMap 中引用的栅格
    const referencedKeys = collectIdentifiers(ast);
    let ref: DEMData | null = null;
    for (const k of referencedKeys) {
        if (rasterMap[k] !== undefined) {
            ref = rasterMap[k];
            break;
        }
    }
    if (ref === null) {
        throw new Error(`evaluate: 表达式 "${expression}" 没有引用任何已知栅格`);
    }
    for (const k of referencedKeys) {
        const r = rasterMap[k];
        if (r === undefined) {
            throw new Error(`evaluate: 标识符 "${k}" 在 rasterMap 中未定义`);
        }
        if (!sameShape(ref, r)) {
            throw new Error(`evaluate: 栅格 "${k}" 形状不匹配`);
        }
    }

    const rows = ref.rows;
    const cols = ref.cols;
    const out = newDemFrom(ref, rows, cols);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const ctx: Record<string, number> = {};
            let hasNaN = false;
            for (const k of referencedKeys) {
                const v = rasterMap[k].values[r]![c]!;
                if (Number.isNaN(v)) { hasNaN = true; break; }
                ctx[k] = v;
            }
            if (hasNaN) {
                out[r][c] = NaN;
            } else {
                out[r][c] = evalAst(ast, ctx);
            }
        }
    }
    return wrap(ref, out);
}

// ─── Tokenizer / Parser / Evaluator ─────────────────────────

type Token =
    | { kind: 'num'; value: number }
    | { kind: 'ident'; value: string }
    | { kind: 'op'; value: string }
    | { kind: 'lparen' }
    | { kind: 'rparen' }
    | { kind: 'comma' };

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
        if (ch === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
        if (ch === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
        if (ch === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
        if ('+-*/^'.indexOf(ch) !== -1) {
            tokens.push({ kind: 'op', value: ch });
            i++;
            continue;
        }
        if ((ch >= '0' && ch <= '9') || ch === '.') {
            let j = i;
            while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
            tokens.push({ kind: 'num', value: parseFloat(src.slice(i, j)) });
            i = j;
            continue;
        }
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
            let j = i;
            while (
                j < src.length &&
                ((src[j] >= 'a' && src[j] <= 'z') ||
                 (src[j] >= 'A' && src[j] <= 'Z') ||
                 (src[j] >= '0' && src[j] <= '9') ||
                 src[j] === '_')
            ) j++;
            tokens.push({ kind: 'ident', value: src.slice(i, j) });
            i = j;
            continue;
        }
        throw new Error(`tokenize: 非法字符 "${ch}" 在位置 ${i}`);
    }
    return tokens;
}

type AstNode =
    | { type: 'num'; value: number }
    | { type: 'var'; name: string }
    | { type: 'unary'; op: string; arg: AstNode }
    | { type: 'binary'; op: string; left: AstNode; right: AstNode }
    | { type: 'call'; name: string; args: AstNode[] };

function parse(tokens: Token[]): AstNode {
    let pos = 0;

    function peek(): Token | null {
        return pos < tokens.length ? tokens[pos] : null;
    }
    function eat(): Token {
        return tokens[pos++];
    }

    function parseExpr(): AstNode {
        return parseAddSub();
    }

    function parseAddSub(): AstNode {
        let node = parseMulDiv();
        while (true) {
            const t = peek();
            if (t && t.kind === 'op' && (t.value === '+' || t.value === '-')) {
                eat();
                node = { type: 'binary', op: t.value, left: node, right: parseMulDiv() };
            } else break;
        }
        return node;
    }

    function parseMulDiv(): AstNode {
        let node = parsePow();
        while (true) {
            const t = peek();
            if (t && t.kind === 'op' && (t.value === '*' || t.value === '/')) {
                eat();
                node = { type: 'binary', op: t.value, left: node, right: parsePow() };
            } else break;
        }
        return node;
    }

    function parsePow(): AstNode {
        const left = parseUnary();
        const t = peek();
        if (t && t.kind === 'op' && t.value === '^') {
            eat();
            return { type: 'binary', op: '^', left, right: parsePow() };
        }
        return left;
    }

    function parseUnary(): AstNode {
        const t = peek();
        if (t && t.kind === 'op' && t.value === '-') {
            eat();
            return { type: 'unary', op: '-', arg: parseUnary() };
        }
        if (t && t.kind === 'op' && t.value === '+') {
            eat();
            return parseUnary();
        }
        return parsePrimary();
    }

    function parsePrimary(): AstNode {
        const t = peek();
        if (!t) throw new Error('parse: 非预期结尾');
        if (t.kind === 'num') {
            eat();
            return { type: 'num', value: t.value };
        }
        if (t.kind === 'ident') {
            eat();
            const next = peek();
            if (next && next.kind === 'lparen') {
                eat();
                const args: AstNode[] = [];
                if (peek()?.kind !== 'rparen') {
                    args.push(parseExpr());
                    while (peek()?.kind === 'comma') {
                        eat();
                        args.push(parseExpr());
                    }
                }
                if (peek()?.kind !== 'rparen') throw new Error(`parse: 缺少 ")" 在函数 ${t.value}`);
                eat();
                return { type: 'call', name: t.value, args };
            }
            return { type: 'var', name: t.value };
        }
        if (t.kind === 'lparen') {
            eat();
            const inner = parseExpr();
            if (peek()?.kind !== 'rparen') throw new Error('parse: 缺少 ")"');
            eat();
            return inner;
        }
        throw new Error(`parse: 非预期 token ${t.kind}`);
    }

    const result = parseExpr();
    if (pos < tokens.length) {
        throw new Error(`parse: 表达式末尾有剩余 token`);
    }
    return result;
}

function collectIdentifiers(ast: AstNode, out: Set<string> = new Set()): string[] {
    switch (ast.type) {
        case 'var':
            out.add(ast.name);
            break;
        case 'unary':
            collectIdentifiers(ast.arg, out);
            break;
        case 'binary':
            collectIdentifiers(ast.left, out);
            collectIdentifiers(ast.right, out);
            break;
        case 'call':
            for (const a of ast.args) collectIdentifiers(a, out);
            break;
    }
    return [...out];
}

const BUILTINS: Record<string, (...args: number[]) => number> = {
    abs: Math.abs,
    sqrt: Math.sqrt,
    log: Math.log,
    exp: Math.exp,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
};

function evalAst(ast: AstNode, ctx: Record<string, number>): number {
    switch (ast.type) {
        case 'num': return ast.value;
        case 'var': {
            if (!(ast.name in ctx)) throw new Error(`evalAst: 未定义变量 ${ast.name}`);
            return ctx[ast.name];
        }
        case 'unary': {
            const v = evalAst(ast.arg, ctx);
            return ast.op === '-' ? -v : v;
        }
        case 'binary': {
            const l = evalAst(ast.left, ctx);
            const r = evalAst(ast.right, ctx);
            switch (ast.op) {
                case '+': return l + r;
                case '-': return l - r;
                case '*': return l * r;
                case '/': return r === 0 ? NaN : l / r;
                case '^': return Math.pow(l, r);
                default: throw new Error(`evalAst: 未知运算符 ${ast.op}`);
            }
        }
        case 'call': {
            const fn = BUILTINS[ast.name];
            if (!fn) throw new Error(`evalAst: 未知函数 ${ast.name}`);
            return fn(...ast.args.map((a) => evalAst(a, ctx)));
        }
    }
}
