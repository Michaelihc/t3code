import { formatDuration } from "@t3tools/shared/orchestrationTiming";

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
  const declaration = /\bexport\s+const\s+meta\s*=/.exec(script);
  if (!declaration) return null;
  const objectStart = skipTrivia(script, declaration.index + declaration[0].length, script.length);
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

export interface ClaudeWorkflowFoldSummary {
  readonly name: string;
  readonly agentCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function workflowFoldDuration(
  workflows: ReadonlyArray<ClaudeWorkflowFoldSummary>,
  now: number,
): string | null {
  const starts = workflows.flatMap((workflow) => {
    if (workflow.startedAt === null) return [];
    const startedAt = Date.parse(workflow.startedAt);
    return Number.isFinite(startedAt) ? [startedAt] : [];
  });
  if (starts.length === 0) return null;
  const ends = workflows.flatMap((workflow) => {
    if (workflow.completedAt === null) return [now];
    const completedAt = Date.parse(workflow.completedAt);
    return Number.isFinite(completedAt) ? [completedAt] : [];
  });
  if (ends.length === 0) return null;
  return formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)));
}

export function formatClaudeWorkflowFoldLabel(
  defaultLabel: string,
  workflows: ReadonlyArray<ClaudeWorkflowFoldSummary>,
  now = Date.now(),
): string {
  if (workflows.length === 0) return defaultLabel;
  const duration = workflowFoldDuration(workflows, now);
  const workflowLabel =
    workflows.length === 1 ? `Workflow ${workflows[0]!.name}` : `${workflows.length} workflows`;
  const agentCount = workflows.reduce((total, workflow) => total + workflow.agentCount, 0);
  return [
    workflowLabel,
    agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : null,
    duration,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
