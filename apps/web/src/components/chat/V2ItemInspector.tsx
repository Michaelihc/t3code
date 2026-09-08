import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronDownIcon, ExternalLinkIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";
import {
  claudeWorkflowScriptFromToolInput,
  parseClaudeWorkflowScriptMeta,
} from "./claudeWorkflowPresentation";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly workflow?: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt"> | undefined;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onRollbackCheckpoint?: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
}

function durationLabel(startedAt: unknown, completedAt: unknown, now: number): string | null {
  if (startedAt == null) return null;
  const start = Date.parse(String(startedAt));
  const end = completedAt == null ? now : Date.parse(String(completedAt));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const milliseconds = Math.max(0, end - start);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function DataField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium tracking-wide uppercase text-muted-foreground/65">
        {props.label}
      </dt>
      <dd className="mt-0.5 min-w-0 break-words font-mono text-[11px] text-foreground/80">
        {props.children}
      </dd>
    </div>
  );
}

function DurationField(props: {
  readonly startedAt: unknown;
  readonly completedAt: unknown;
  readonly live: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!props.live) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [props.live]);

  const duration = durationLabel(props.startedAt, props.completedAt, now);
  return duration ? <DataField label="Duration">{duration}</DataField> : null;
}

function StructuredValue({ value }: { readonly value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
      {text}
    </pre>
  );
}

function markdownCodeFence(source: string): string {
  const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}typescript\n${source}\n${fence}`;
}

function WorkflowToolInspector(props: {
  readonly item: Extract<OrchestrationV2ProjectedTurnItem["item"], { type: "dynamic_tool" }>;
  readonly script: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd?: string | undefined;
}) {
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const meta = useMemo(() => parseClaudeWorkflowScriptMeta(props.script), [props.script]);
  const inputWithoutScript =
    typeof props.item.input === "object" && props.item.input !== null
      ? Object.fromEntries(Object.entries(props.item.input).filter(([key]) => key !== "script"))
      : undefined;
  const hasOtherInput = inputWithoutScript && Object.keys(inputWithoutScript).length > 0;

  return (
    <div className="space-y-2">
      {meta?.description ? (
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {meta.description}
        </p>
      ) : null}
      {meta && meta.phases.length > 0 ? (
        <ol className="space-y-1.5 border-s border-border/55 ps-3">
          {meta.phases.map((phase, index) => (
            <li
              key={`${phase.title}:${phase.detail ?? ""}`}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1"
            >
              <span className="font-mono text-[10px] leading-5 text-muted-foreground/60">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground/85">{phase.title}</span>
                {phase.detail ? (
                  <span className="block text-[11px] leading-relaxed text-muted-foreground">
                    {phase.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {hasOtherInput ? <StructuredValue value={inputWithoutScript} /> : null}
      {props.item.output !== undefined ? <StructuredValue value={props.item.output} /> : null}
      <div className="rounded-md border border-border/45 bg-background/40">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="w-full justify-start rounded-md px-2 text-muted-foreground"
          aria-expanded={scriptExpanded}
          onClick={() => setScriptExpanded((expanded) => !expanded)}
        >
          <ChevronDownIcon
            className={`size-3 transition-transform ${scriptExpanded ? "rotate-180" : ""}`}
            aria-hidden
          />
          {scriptExpanded ? "Hide workflow script" : "Show workflow script"}
        </Button>
        {scriptExpanded ? (
          <div className="max-h-96 overflow-auto border-t border-border/45 px-2 py-1.5 text-[11px]">
            <ChatMarkdown
              text={markdownCodeFence(props.script)}
              cwd={props.cwd}
              threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const { item } = props.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const workflowLive =
    props.workflow?.status === "pending" ||
    props.workflow?.status === "running" ||
    props.workflow?.status === "waiting";
  const workflowScript =
    item.type === "dynamic_tool"
      ? claudeWorkflowScriptFromToolInput(item.toolName, item.input)
      : null;
  const latestAttempt = support.attempts.at(-1) ?? null;
  const runtimeRequest = support.runtimeRequest;

  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border/45 bg-muted/15 p-2 sm:grid-cols-3">
        <DataField label="Item">{item.type}</DataField>
        <DataField label="Status">{props.workflow?.status ?? item.status}</DataField>
        <DurationField
          startedAt={props.workflow ? props.workflow.startedAt : item.startedAt}
          completedAt={props.workflow ? props.workflow.completedAt : item.completedAt}
          live={workflowLive}
        />
        {support.run ? <DataField label="Run">{support.run.status}</DataField> : null}
        {latestAttempt ? (
          <DataField label="Attempt">
            {latestAttempt.attemptOrdinal} · {latestAttempt.status} · {latestAttempt.reason}
          </DataField>
        ) : null}
        {support.node ? (
          <DataField label="Node">
            {support.node.kind} · {support.node.status}
          </DataField>
        ) : null}
        {support.providerThread ? (
          <DataField label="Provider thread">
            {support.providerThread.providerInstanceId} · {support.providerThread.status}
          </DataField>
        ) : null}
        {support.providerTurn ? (
          <DataField label="Provider turn">{support.providerTurn.status}</DataField>
        ) : null}
        {support.providerSession ? (
          <DataField label="Session">
            {support.providerSession.status} · {support.providerSession.model ?? "default model"}
          </DataField>
        ) : null}
        {support.providerSession ? (
          <DataField label="Working directory">{support.providerSession.cwd}</DataField>
        ) : null}
        {runtimeRequest ? (
          <DataField label="Request">
            {runtimeRequest.status} · {runtimeRequest.responseCapability.type}
          </DataField>
        ) : null}
      </dl>

      {support.attempts.length > 1 ? (
        <details className="rounded-md border border-border/45 bg-background/40">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            Attempt history · {support.attempts.length}
          </summary>
          <ol className="space-y-1 border-t border-border/45 p-2 font-mono text-[11px] text-muted-foreground">
            {support.attempts.map((attempt) => (
              <li key={attempt.id} className="flex items-center justify-between gap-3">
                <span>
                  Attempt {attempt.attemptOrdinal} · {attempt.reason.replaceAll("_", " ")}
                </span>
                <span>{attempt.status}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <div className="space-y-2">
          <StructuredValue value={item.input} />
          {item.output !== undefined ? <StructuredValue value={item.output} /> : null}
          {item.exitCode !== undefined ? (
            <p className={item.exitCode === 0 ? "text-emerald-600" : "text-destructive"}>
              Process exited with code {item.exitCode}
            </p>
          ) : null}
        </div>
      ) : null}

      {item.type === "file_change" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-muted-foreground">
            {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
          </span>
          {item.additions !== undefined || item.deletions !== undefined ? (
            <span>
              <span className="text-emerald-600">+{item.additions ?? 0}</span>{" "}
              <span className="text-destructive">-{item.deletions ?? 0}</span>
            </span>
          ) : null}
          {item.runId !== null ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onOpenTurnDiff(item.runId!, item.fileName)}
            >
              Open diff
            </Button>
          ) : null}
          {item.diffStr ? <StructuredValue value={item.diffStr} /> : null}
        </div>
      ) : null}

      {item.type === "file_search" && item.results ? (
        <ul className="space-y-1 rounded-md border border-border/45 p-2">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results ? (
        <ul className="space-y-1.5 rounded-md border border-border/45 p-2">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" && workflowScript !== null ? (
        <WorkflowToolInspector
          item={item}
          script={workflowScript}
          environmentId={props.environmentId}
          threadId={props.projectedItem.sourceThreadId}
          cwd={props.cwd}
        />
      ) : item.type === "dynamic_tool" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
              Input
            </p>
            <StructuredValue value={item.input} />
          </div>
          {item.output !== undefined ? (
            <div>
              <p className="mb-1 text-[10px] font-medium tracking-wide uppercase text-muted-foreground">
                Output
              </p>
              <StructuredValue value={item.output} />
            </div>
          ) : null}
        </div>
      ) : null}

      {item.type === "checkpoint" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {support.checkpoint?.status ?? item.status} · {item.files.length} files
          </span>
          {props.onRollbackCheckpoint && support.checkpoint?.status === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onRollbackCheckpoint?.({
                  checkpointId: item.checkpointId,
                  scopeId: item.scopeId,
                })
              }
            >
              <RotateCcwIcon className="size-3" />
              Roll back
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.type === "fork" ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.targetThreadId)}>
          <GitBranchIcon className="size-3" />
          Open fork
        </Button>
      ) : null}

      {item.type === "subagent" && item.childThreadId !== null ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.childThreadId!)}>
          Open subagent thread
        </Button>
      ) : null}

      {item.type === "handoff" ? (
        <div className="space-y-1 rounded-md border border-border/45 p-2 text-muted-foreground">
          <p>
            {item.fromProviderInstanceIds.join(", ")} → {item.toProviderInstanceId}
          </p>
          <p>
            {item.strategy.replaceAll("_", " ")} · {support.contextHandoff?.status ?? item.status}
          </p>
          {support.contextTransfer ? (
            <p>
              Transfer {support.contextTransfer.type.replaceAll("_", " ")} ·{" "}
              {support.contextTransfer.status}
            </p>
          ) : null}
        </div>
      ) : null}

      <details
        className="group/raw rounded-md border border-border/45 bg-background/40"
        data-v2-structured-details="true"
      >
        <summary className="flex cursor-pointer list-none items-center px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          Structured details
        </summary>
        <div className="border-t border-border/45 p-2">
          <StructuredValue value={item} />
        </div>
      </details>
    </div>
  );
});
