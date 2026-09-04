export interface ClaudeWorkflowPhaseMeta {
  readonly title: string;
  readonly detail?: string;
}

export interface ClaudeWorkflowScriptMeta {
  readonly name?: string;
  readonly description?: string;
  readonly phases: ReadonlyArray<ClaudeWorkflowPhaseMeta>;
}

interface SourceProperty {
  readonly key: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

function skipTrivia(source: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    if (/\s/.test(source[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? end : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const close = source.indexOf("*/", cursor + 2);
      cursor = close === -1 ? end : close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function quotedStringEnd(source: string, start: number, end: number): number | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
  }
  return null;
}

function identifierEnd(source: string, start: number, end: number): number | null {
  if (!/[A-Za-z_$]/.test(source[start] ?? "")) return null;
  let cursor = start + 1;
  while (cursor < end && /[\w$]/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function exactIdentifierEnd(
  source: string,
  start: number,
  end: number,
  expected: string,
): number | null {
  const tokenEnd = identifierEnd(source, start, end);
  return tokenEnd !== null && source.slice(start, tokenEnd) === expected ? tokenEnd : null;
}

function regexLiteralEnd(source: string, start: number, end: number): number | null {
  if (source[start] !== "/") return null;
  let inCharacterClass = false;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "\n" || character === "\r") return null;
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (character === "/" && !inCharacterClass) {
      cursor += 1;
      while (cursor < end && /[A-Za-z]/.test(source[cursor]!)) cursor += 1;
      return cursor;
    }
  }
  return null;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function metaInitializerEquals(source: string, start: number): number | null {
  let cursor = skipTrivia(source, start, source.length);
  if (source[cursor] === "=") return cursor;
  if (source[cursor] !== ":") return null;

  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  cursor += 1;
  while (cursor < source.length) {
    const nextToken = skipTrivia(source, cursor, source.length);
    if (nextToken !== cursor) {
      cursor = nextToken;
      continue;
    }
    const stringEnd = quotedStringEnd(source, cursor, source.length);
    if (stringEnd !== null) {
      cursor = stringEnd;
      continue;
    }

    const character = source[cursor]!;
    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (character === "=" && source[cursor + 1] !== ">" && atTopLevel) return cursor;
    if (character === ";" && atTopLevel) return null;
    if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    cursor += 1;
  }
  return null;
}

function exportedMetaObjectStart(source: string): number | null {
  let cursor = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let canStartRegex = true;

  while (cursor < source.length) {
    const nextToken = skipTrivia(source, cursor, source.length);
    if (nextToken !== cursor) {
      cursor = nextToken;
      continue;
    }

    const stringEnd = quotedStringEnd(source, cursor, source.length);
    if (stringEnd !== null) {
      cursor = stringEnd;
      canStartRegex = false;
      continue;
    }

    if (source[cursor] === "/" && canStartRegex) {
      const literalEnd = regexLiteralEnd(source, cursor, source.length);
      if (literalEnd !== null) {
        cursor = literalEnd;
        canStartRegex = false;
        continue;
      }
    }

    const tokenEnd = identifierEnd(source, cursor, source.length);
    if (tokenEnd !== null) {
      const token = source.slice(cursor, tokenEnd);
      if (token === "export" && braces === 0 && brackets === 0 && parentheses === 0) {
        const constStart = skipTrivia(source, tokenEnd, source.length);
        const constEnd = exactIdentifierEnd(source, constStart, source.length, "const");
        if (constEnd !== null) {
          const metaStart = skipTrivia(source, constEnd, source.length);
          const metaEnd = exactIdentifierEnd(source, metaStart, source.length, "meta");
          if (metaEnd !== null) {
            const equals = metaInitializerEquals(source, metaEnd);
            if (equals !== null) {
              const objectStart = skipTrivia(source, equals + 1, source.length);
              if (source[objectStart] === "{") return objectStart;
            }
          }
        }
      }
      cursor = tokenEnd;
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(token);
      continue;
    }

    const character = source[cursor]!;
    if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);

    canStartRegex = !/[\w$)\]}.'"]/.test(character);
    cursor += 1;
  }
  return null;
}

function balancedEnd(
  source: string,
  start: number,
  open: "{" | "[",
  close: "}" | "]",
  end = source.length,
): number | null {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const quotedEnd = quotedStringEnd(source, cursor, end);
    if (quotedEnd !== null) {
      cursor = quotedEnd - 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? end : newline;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? end : commentEnd + 1;
      continue;
    }
    if (source[cursor] === open) depth += 1;
    if (source[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return null;
}

function decodeQuotedString(source: string, start: number, end: number): string | undefined {
  const literalEnd = quotedStringEnd(source, start, end);
  if (literalEnd === null) return undefined;
  const value = source
    .slice(start + 1, literalEnd - 1)
    .replace(
      /\\([\\'"`nrt])/g,
      (_match, escaped: string) => ({ n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped,
    );
  return value.trim().length > 0 ? value.trim() : undefined;
}

function objectProperties(
  source: string,
  start: number,
  end: number,
): ReadonlyArray<SourceProperty> {
  const properties: SourceProperty[] = [];
  let cursor = start + 1;
  while (cursor < end - 1) {
    cursor = skipTrivia(source, cursor, end - 1);
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "}") break;

    let key: string | undefined;
    const keyEnd = quotedStringEnd(source, cursor, end);
    if (keyEnd !== null) {
      key = decodeQuotedString(source, cursor, end);
      cursor = keyEnd;
    } else {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor, end));
      if (!identifier) break;
      key = identifier[0];
      cursor += identifier[0].length;
    }
    cursor = skipTrivia(source, cursor, end);
    if (source[cursor] !== ":") break;
    cursor = skipTrivia(source, cursor + 1, end);
    const valueStart = cursor;
    let braces = 0;
    let brackets = 0;
    for (; cursor < end - 1; cursor += 1) {
      const valueStringEnd = quotedStringEnd(source, cursor, end);
      if (valueStringEnd !== null) {
        cursor = valueStringEnd - 1;
        continue;
      }
      if (source[cursor] === "{") braces += 1;
      else if (source[cursor] === "}") {
        if (braces === 0 && brackets === 0) break;
        braces -= 1;
      } else if (source[cursor] === "[") brackets += 1;
      else if (source[cursor] === "]") brackets -= 1;
      else if (source[cursor] === "," && braces === 0 && brackets === 0) break;
    }
    if (key) properties.push({ key, valueStart, valueEnd: cursor });
  }
  return properties;
}

function stringProperty(
  source: string,
  properties: ReadonlyArray<SourceProperty>,
  key: string,
): string | undefined {
  const property = properties.find((candidate) => candidate.key === key);
  return property ? decodeQuotedString(source, property.valueStart, property.valueEnd) : undefined;
}

export function parseClaudeWorkflowScriptMeta(script: string): ClaudeWorkflowScriptMeta | null {
  const objectStart = exportedMetaObjectStart(script);
  if (objectStart === null) return null;
  const objectEnd = balancedEnd(script, objectStart, "{", "}");
  if (objectEnd === null) return null;

  const properties = objectProperties(script, objectStart, objectEnd);
  const phasesProperty = properties.find((property) => property.key === "phases");
  const phases: ClaudeWorkflowPhaseMeta[] = [];
  if (phasesProperty && script[phasesProperty.valueStart] === "[") {
    const arrayEnd = balancedEnd(
      script,
      phasesProperty.valueStart,
      "[",
      "]",
      phasesProperty.valueEnd + 1,
    );
    if (arrayEnd !== null) {
      let cursor = phasesProperty.valueStart + 1;
      while (cursor < arrayEnd - 1) {
        cursor = skipTrivia(script, cursor, arrayEnd - 1);
        if (script[cursor] === ",") {
          cursor += 1;
          continue;
        }
        if (script[cursor] !== "{") break;
        const phaseEnd = balancedEnd(script, cursor, "{", "}", arrayEnd);
        if (phaseEnd === null) break;
        const phaseProperties = objectProperties(script, cursor, phaseEnd);
        const title = stringProperty(script, phaseProperties, "title");
        const detail = stringProperty(script, phaseProperties, "detail");
        if (title) phases.push({ title, ...(detail === undefined ? {} : { detail }) });
        cursor = phaseEnd;
      }
    }
  }

  const name = stringProperty(script, properties, "name");
  const description = stringProperty(script, properties, "description");
  return name === undefined && description === undefined && phases.length === 0
    ? null
    : {
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        phases,
      };
}

export function claudeWorkflowScriptFromToolInput(
  toolName: string | null | undefined,
  input: unknown,
): string | null {
  if (
    toolName?.trim().toLowerCase() !== "workflow" ||
    typeof input !== "object" ||
    input === null
  ) {
    return null;
  }
  const script = Reflect.get(input, "script");
  return typeof script === "string" && script.trim().length > 0 ? script : null;
}
