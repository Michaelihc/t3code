import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import {
  claudeWorkflowScriptFromToolInput,
  parseClaudeWorkflowScriptMeta,
} from "@t3tools/client-runtime/claude-workflow-meta";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, type ColorValue, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { buildThreadActivityInspector } from "../../lib/threadActivityInspector";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { buildThreadActivityFileParams } from "./threadActivityFileNavigation";
import { workflowElapsedLabel, workflowIsLive } from "./mobile-workflow-presentation";

type InspectorWorkflow = Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;

function InspectorField(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="min-w-[42%] flex-1 gap-0.5">
      <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
        {props.label}
      </Text>
      <Text selectable className="text-2xs leading-4 text-foreground">
        {props.value}
      </Text>
    </View>
  );
}

function WorkflowDurationField(props: { readonly workflow: InspectorWorkflow }) {
  const live = workflowIsLive(props.workflow);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [live]);

  const duration = workflowElapsedLabel(props.workflow, now);
  return duration ? <InspectorField label="Duration" value={duration} /> : null;
}

export function ThreadActivityInspector(props: {
  readonly activity: ThreadFeedActivity;
  readonly currentThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly workflow?: Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt">;
  readonly workspaceRoot?: string | null;
}) {
  const navigation = useNavigation();
  const row = props.activity.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
  });
  const workflowScript = useMemo(
    () =>
      row.item.type === "dynamic_tool"
        ? claudeWorkflowScriptFromToolInput(row.item.toolName, row.item.input)
        : null,
    [row.item],
  );
  const workflowMeta = useMemo(
    () => (workflowScript === null ? null : parseClaudeWorkflowScriptMeta(workflowScript)),
    [workflowScript],
  );
  const model = useMemo(
    () =>
      buildThreadActivityInspector(props.activity, support, props.currentThreadId, props.workflow),
    [props.activity, props.currentThreadId, props.workflow, support],
  );
  const revertCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    label: "checkpoint rollback",
    reportFailure: true,
  });
  const [rollingBack, setRollingBack] = useState(false);
  const [workflowScriptExpanded, setWorkflowScriptExpanded] = useState(false);

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-x-4 gap-y-2 rounded-lg border border-adaptive-neutral-300-a60-white-a12 bg-adaptive-black-a2p5-white-a2p5 p-2.5">
        {model.fields.map((field) =>
          field.label === "Duration" && props.workflow ? (
            <WorkflowDurationField key="Duration" workflow={props.workflow} />
          ) : (
            <InspectorField key={`${field.label}:${field.value}`} {...field} />
          ),
        )}
      </View>

      {workflowMeta?.description ? (
        <Text className="text-xs leading-5 text-foreground-muted">{workflowMeta.description}</Text>
      ) : null}

      {workflowMeta && workflowMeta.phases.length > 0 ? (
        <View className="gap-1.5">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            Declared phases
          </Text>
          {workflowMeta.phases.map((phase, index) => (
            <View
              key={`${phase.title}:${phase.detail ?? ""}`}
              className="rounded-lg border border-adaptive-neutral-300-a60-white-a12 px-2.5 py-2"
            >
              <Text className="font-t3-medium text-xs text-foreground">
                {index + 1}. {phase.title}
              </Text>
              {phase.detail ? (
                <Text className="mt-0.5 text-2xs leading-4 text-foreground-muted">
                  {phase.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {workflowScript ? (
        <View className="gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: workflowScriptExpanded }}
            onPress={() => {
              void Haptics.selectionAsync();
              setWorkflowScriptExpanded((expanded) => !expanded);
            }}
            className="min-h-9 flex-row items-center justify-between rounded-lg border border-adaptive-neutral-300-a60-white-a12 px-2.5 py-1.5"
          >
            <Text className="font-t3-medium text-xs text-foreground">Workflow script</Text>
            <SymbolView
              name={
                workflowScriptExpanded
                  ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                  : { ios: "chevron.down", android: "keyboard_arrow_down" }
              }
              size={11}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
          {workflowScriptExpanded ? (
            <ScrollView
              nestedScrollEnabled
              directionalLockEnabled
              showsVerticalScrollIndicator
              style={{ maxHeight: 240 }}
              contentContainerStyle={{ padding: 10 }}
              className="rounded-lg bg-adaptive-black-a2p5-white-a2p5"
            >
              <Text
                selectable
                className="text-2xs leading-[17px] text-foreground-muted"
                style={{ fontFamily: "ui-monospace" }}
              >
                {workflowScript}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {model.blocks.map((block) => (
        <View key={`${block.label}:${block.value}`} className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            {block.label}
          </Text>
          <ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: 240 }}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            <Text
              selectable
              className="text-2xs leading-[17px] text-foreground-muted"
              style={block.monospaced ? { fontFamily: "ui-monospace" } : undefined}
            >
              {block.value}
            </Text>
          </ScrollView>
        </View>
      ))}

      {model.fileLinks.length > 0 ? (
        <View className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            Files
          </Text>
          {model.fileLinks.map((link) => {
            const relativePath =
              resolveWorkspaceRelativeFilePath(props.workspaceRoot, link.path) ??
              (link.path.startsWith("/") ? null : link.path);
            return (
              <Pressable
                key={`${link.path}:${link.line ?? 0}:${link.label}`}
                accessibilityRole={relativePath ? "link" : undefined}
                disabled={relativePath === null}
                onPress={() => {
                  if (!relativePath) return;
                  void Haptics.selectionAsync();
                  navigation.navigate(
                    "ThreadFile",
                    buildThreadActivityFileParams({
                      environmentId: props.environmentId,
                      currentThreadId: props.currentThreadId,
                      activitySourceThreadId: row.sourceThreadId,
                      relativePath,
                      line: link.line,
                    }),
                  );
                }}
                className="min-h-9 flex-row items-center gap-2 rounded-md border border-adaptive-neutral-300-a60-white-a12 px-2.5 py-1.5"
              >
                <SymbolView
                  name="doc.text"
                  size={13}
                  tintColor={props.iconColor}
                  type="monochrome"
                />
                <Text className="min-w-0 flex-1 text-2xs leading-4 text-foreground">
                  {link.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {model.webLinks.length > 0 ? (
        <View className="gap-1">
          <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
            Sources
          </Text>
          {model.webLinks.map((link) => (
            <Pressable
              key={link.url}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(link.url)}
              className="min-h-9 flex-row items-center gap-2 rounded-md border border-adaptive-neutral-300-a60-white-a12 px-2.5 py-1.5"
            >
              <SymbolView
                name="arrow.up.right.square"
                size={13}
                tintColor={props.iconColor}
                type="monochrome"
              />
              <Text className="min-w-0 flex-1 text-2xs leading-4 text-foreground">
                {link.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {model.rollbackTarget ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Roll back to this checkpoint"
          disabled={rollingBack}
          onPress={() => {
            setRollingBack(true);
            void Haptics.selectionAsync();
            void revertCheckpoint({
              environmentId: props.environmentId,
              input: {
                threadId: model.rollbackTarget!.threadId,
                checkpointId: model.rollbackTarget!.checkpointId,
                scopeId: model.rollbackTarget!.scopeId,
              },
            }).finally(() => setRollingBack(false));
          }}
          className="min-h-10 flex-row items-center justify-center gap-2 rounded-lg border border-adaptive-neutral-300-a60-white-a12 px-3 py-2"
        >
          <SymbolView
            name={rollingBack ? "hourglass" : "arrow.counterclockwise"}
            size={14}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="font-t3-medium text-xs text-foreground">
            {rollingBack ? "Rolling back…" : "Roll back to checkpoint"}
          </Text>
        </Pressable>
      ) : null}

      <View className="gap-1 border-t border-adaptive-neutral-300-a60-white-a12 pt-2">
        <Text className="font-t3-medium text-3xs uppercase tracking-wide text-foreground-muted opacity-60">
          Structured details
        </Text>
        <ScrollView
          nestedScrollEnabled
          directionalLockEnabled
          showsVerticalScrollIndicator
          style={{ maxHeight: 280 }}
          contentContainerStyle={{ paddingRight: 8 }}
        >
          <Text
            selectable
            className="text-2xs leading-[17px] text-foreground-muted"
            style={{ fontFamily: "ui-monospace" }}
          >
            {model.structuredDetails}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}
