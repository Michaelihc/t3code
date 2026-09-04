import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { AccessibilityInfo, AppState, type ColorValue, Pressable, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { T3_CODE_BRAND_MARK_SOURCE } from "../../components/brandAssets";
import { cn } from "../../lib/cn";
import { threadFeedActivityIsVisible, type ThreadFeedActivity } from "../../lib/threadActivity";
import type { ToolGroupSummaryKind } from "@t3tools/client-runtime/work-log/presentation";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { ThreadActivityInspector } from "./ThreadActivityInspector";
import {
  resolveThreadActivityMetadata,
  resolveThreadActivityStatus,
} from "./thread-activity-row-presentation";
import {
  workflowElapsedLabel,
  workflowIsLive,
  workflowMemberActivity,
  workflowMembers,
  workflowToolUseIdForProjectedItem,
  type MobileWorkflowGroupStore,
} from "./mobile-workflow-presentation";

const SHIMMER_WIDTH = 72;
const SHIMMER_SWEEP_MS = 1_350;
const SHIMMER_PAUSE_MS = 1_450;
const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);

function ShimmerWorkContent(props: {
  readonly highlighted: boolean;
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly onTextLayout?: ComponentProps<typeof Text>["onTextLayout"];
  readonly showIcon: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="h-6 w-6 shrink-0 items-center justify-center">
        {props.showIcon ? (
          <SymbolView
            name={props.icon}
            size={14}
            weight="medium"
            {...(props.highlighted
              ? { tintColorClassName: "accent-foreground" as const }
              : { tintColor: props.iconSubtleColor })}
            type="monochrome"
          />
        ) : null}
      </View>
      <Text
        className={cn(
          "min-w-0 shrink text-sm",
          props.highlighted ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
        onTextLayout={props.onTextLayout}
      >
        {props.label}
      </Text>
    </View>
  );
}

function ShimmeringWorkContent(props: {
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly showIcon: boolean;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const [reducedMotion, setReducedMotion] = useState(true);
  const screenIsFocused = useIsFocused();
  const progress = useSharedValue(0);
  const gradientId = `work-shimmer-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(availableWidth, SHIMMER_ICON_AND_GAP_WIDTH + Math.ceil(textWidth));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (contentWidth <= 0 || reducedMotion || !appIsActive || !screenIsFocused) return;

    progress.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: SHIMMER_SWEEP_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        withDelay(
          SHIMMER_PAUSE_MS,
          withTiming(0, { duration: 0, reduceMotion: ReduceMotion.Never }),
        ),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [appIsActive, contentWidth, progress, reducedMotion, screenIsFocused]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -SHIMMER_WIDTH + progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));
  const counterSweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SHIMMER_WIDTH - progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));

  return (
    <View
      className="min-w-0 flex-1"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <ShimmerWorkContent
        highlighted={false}
        icon={props.icon}
        iconSubtleColor={props.iconSubtleColor}
        label={props.label}
        showIcon={props.showIcon}
        onTextLayout={(event) => setTextWidth(event.nativeEvent.lines[0]?.width ?? 0)}
      />
      {!reducedMotion && appIsActive && screenIsFocused && contentWidth > 0 ? (
        <Animated.View
          className="absolute inset-y-0 left-0 overflow-hidden"
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ width: SHIMMER_WIDTH }, sweepStyle]}
        >
          <MaskedView
            className="absolute inset-0"
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <Animated.View style={[{ width: availableWidth }, counterSweepStyle]}>
              <ShimmerWorkContent
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
              />
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

function WorkRowIcon(props: {
  readonly row: ThreadFeedActivity;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly failed: boolean;
}) {
  if (props.row.logo === "t3-code") {
    return (
      <Image
        source={T3_CODE_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{ width: 16, height: 16, borderRadius: 4 }}
      />
    );
  }

  const iconIsDestructive = props.row.icon === "alert" || props.row.icon === "warning";
  return (
    <SymbolView
      name={props.failed ? { ios: "xmark", android: "close" } : workRowSymbolName(props.row.icon)}
      size={14}
      weight="medium"
      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
      type="monochrome"
    />
  );
}

function ThreadActivityThreadRow(props: {
  readonly activity: ThreadFeedActivity;
  readonly environmentId: EnvironmentId;
  readonly iconColor: import("react-native").ColorValue;
}) {
  const row = props.activity.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
  });
  const navigation = useNavigation();
  const item = row.item;
  let targetThreadId: ThreadId | null = null;
  let label = "Open related thread";
  let providerDriver = support.providerSession?.driver ?? null;
  let providerInstanceId = support.providerSession?.providerInstanceId ?? null;
  let model = support.providerSession?.model ?? null;

  if (item.type === "thread_created") {
    targetThreadId = item.targetThreadId;
    label = "Open created thread";
    providerInstanceId = item.targetProviderInstanceId;
    model = item.targetModel;
  } else if (item.type === "subagent") {
    targetThreadId = support.subagent?.childThreadId ?? item.childThreadId;
    label = "Open subagent thread";
    providerDriver = support.subagent?.driver ?? item.driver;
    providerInstanceId = support.subagent?.providerInstanceId ?? item.providerInstanceId;
    model = support.subagent?.model ?? model;
  } else if (item.type === "fork") {
    targetThreadId =
      item.targetThreadId === row.sourceThreadId && item.source.type === "run"
        ? item.source.threadId
        : item.targetThreadId;
    label = targetThreadId === item.targetThreadId ? "Open forked thread" : "Open parent thread";
  }

  const metadata = resolveThreadActivityMetadata({ providerDriver, providerInstanceId, model });
  const status = resolveThreadActivityStatus(item.status);
  const statusDotClassName =
    status.tone === "success"
      ? "bg-emerald-500"
      : status.tone === "danger"
        ? "bg-rose-500"
        : status.tone === "warning"
          ? "bg-amber-500"
          : "bg-sky-500";

  return (
    <View className="mb-2 min-h-11 flex-row items-center gap-2 rounded-xl border border-continuous border-adaptive-neutral-950-a10-white-a10 bg-card px-2.5 py-1.5">
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={status.label}
        className={cn("size-2 shrink-0 rounded-full", statusDotClassName)}
      />

      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        <Text className="font-t3-medium text-foreground">{props.activity.summary}</Text>
        {metadata ? <Text className="text-foreground-muted opacity-60"> · {metadata}</Text> : null}
      </Text>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel={label}
        disabled={targetThreadId === null}
        hitSlop={10}
        onPress={() => {
          if (targetThreadId === null) return;
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: targetThreadId,
          });
        }}
        className="h-8 shrink-0 flex-row items-center gap-1 rounded-lg bg-adaptive-neutral-950-a5-white-a5 py-1.5 pl-2.5 pr-1.5 active:bg-adaptive-neutral-950-a10-white-a10 disabled:opacity-40"
      >
        <Text className="font-t3-medium text-sm text-foreground">Open</Text>
        <SymbolView name="arrow.right" size={11} tintColor={props.iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

const WORKFLOW_STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { readonly dotClass: string; readonly label: string }
> = {
  pending: { dotClass: "bg-sky-500", label: "Working" },
  running: { dotClass: "bg-sky-500", label: "Working" },
  waiting: { dotClass: "bg-sky-500", label: "Waiting" },
  idle: { dotClass: "bg-adaptive-neutral-500-400", label: "Idle" },
  completed: { dotClass: "bg-emerald-500", label: "Completed" },
  failed: { dotClass: "bg-rose-500", label: "Failed" },
  cancelled: { dotClass: "bg-adaptive-neutral-500-400", label: "Stopped" },
  interrupted: { dotClass: "bg-adaptive-neutral-500-400", label: "Stopped" },
};

function WorkflowStatusDot(props: { readonly status: RuntimeSubagent["status"] }) {
  const visuals = WORKFLOW_STATUS_VISUALS[props.status];
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={visuals.label}
      className={cn("size-2 shrink-0 rounded-full", visuals.dotClass)}
    />
  );
}

function WorkflowSummary(props: { readonly group: AgentPanelWorkflowGroup }) {
  const live = workflowIsLive(props.group.workflow);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [live]);

  const members = workflowMembers(props.group);
  const elapsed = workflowElapsedLabel(props.group.workflow, now);
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-2">
      <WorkflowStatusDot status={props.group.workflow.status} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        <Text className="font-t3-medium text-foreground">
          {props.group.workflow.workflowName ?? props.group.workflow.title}
        </Text>
        <Text className="text-foreground-muted">
          {` · ${members.length} ${members.length === 1 ? "agent" : "agents"}`}
          {elapsed ? ` · ${elapsed}` : ""}
        </Text>
      </Text>
    </View>
  );
}

function WorkflowMemberRow(props: { readonly member: RuntimeSubagent }) {
  const visuals = WORKFLOW_STATUS_VISUALS[props.member.status];
  const model = formatSubagentModelLabel(props.member.model, props.member.effort);
  const metadata = [
    model,
    props.member.usage ? `${formatSubagentTokenCount(props.member.usage.totalTokens)} tok` : null,
    props.member.usage?.toolUses === undefined ? null : `${props.member.usage.toolUses} tools`,
    props.member.attempt === null ? null : `attempt ${props.member.attempt}`,
  ].filter((value): value is string => value !== null && value.length > 0);
  const activity = workflowMemberActivity(props.member);

  return (
    <View className="min-h-16 border-t border-adaptive-neutral-950-a5-white-a8 py-2 pl-1">
      <View className="flex-row items-center gap-2">
        <WorkflowStatusDot status={props.member.status} />
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {props.member.title}
        </Text>
        <Text className="shrink-0 text-2xs text-foreground-muted">{visuals.label}</Text>
      </View>
      {activity ? (
        <Text className="ml-4 mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
          {activity}
        </Text>
      ) : null}
      {metadata.length > 0 ? (
        <Text className="ml-4 mt-0.5 text-2xs tabular-nums text-foreground-muted" numberOfLines={1}>
          {metadata.join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function WorkflowRoster(props: { readonly group: AgentPanelWorkflowGroup }) {
  return (
    <View className="mb-2 overflow-hidden rounded-xl border border-adaptive-neutral-950-a10-white-a10 bg-card px-2.5 py-1.5">
      {props.group.phases.map((phase) => (
        <View key={phase.index}>
          <View className="min-h-8 flex-row items-center gap-2 py-1">
            <Text className="min-w-0 flex-1 font-t3-medium text-xs uppercase tracking-wider text-foreground-muted">
              {phase.title}
            </Text>
            <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">
              {phase.state === "pending"
                ? "Pending"
                : phase.state === "done"
                  ? `${phase.settledCount} done`
                  : `${phase.activeCount} active · ${phase.settledCount} done`}
            </Text>
          </View>
          {phase.members.map((member) => (
            <WorkflowMemberRow key={member.id} member={member} />
          ))}
        </View>
      ))}
      {props.group.unphasedMembers.map((member) => (
        <WorkflowMemberRow key={member.id} member={member} />
      ))}
    </View>
  );
}

// Routine neutral tool activity carries no signal worth a row. Prominent
// linked activity stays visible so its live status and thread affordance do.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter(threadFeedActivityIsVisible);
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly workflowStore: MobileWorkflowGroupStore;
  readonly copiedRowId: string | null;
  readonly currentThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
  readonly workspaceRoot?: string | null;
}) {
  const workflowToolUseIds = useMemo(
    () =>
      props.activities.flatMap((activity) => {
        const toolUseId = workflowToolUseIdForProjectedItem(activity.projectedItem);
        return toolUseId === null ? [] : [toolUseId];
      }),
    [props.activities],
  );
  const subscribeToWorkflows = useCallback(
    (listener: () => void) => props.workflowStore.subscribe(workflowToolUseIds, listener),
    [props.workflowStore, workflowToolUseIds],
  );
  const getWorkflowSnapshot = useCallback(
    () => props.workflowStore.snapshot(workflowToolUseIds),
    [props.workflowStore, workflowToolUseIds],
  );
  useSyncExternalStore(subscribeToWorkflows, getWorkflowSnapshot, getWorkflowSnapshot);

  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <View className="gap-px">
        {rows.map((row) => {
          const workflowGroup = props.workflowStore.groupForProjectedItem(row.projectedItem);
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand || workflowGroup !== null;
          const displayText = workflowGroup
            ? `${workflowGroup.workflow.workflowName ?? workflowGroup.workflow.title}, ${workflowMembers(workflowGroup).length} agents`
            : (row.detail ?? row.summary);
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";
          const failed = workflowGroup
            ? workflowGroup.workflow.status === "failed"
            : row.status === "failure";
          const showIcon = !row.groupedToolDetail || iconIsDestructive || failed;

          if (row.prominent) {
            return (
              <Animated.View
                key={row.id}
                layout={WORK_LOG_LAYOUT_TRANSITION}
                className="overflow-hidden"
                {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
              >
                <ThreadActivityThreadRow
                  activity={row}
                  environmentId={props.environmentId}
                  iconColor={props.iconSubtleColor}
                />
              </Animated.View>
            );
          }

          return (
            <Animated.View
              key={row.id}
              layout={WORK_LOG_LAYOUT_TRANSITION}
              className="overflow-hidden"
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={failed ? `${displayText}, tool call failed` : displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    void Haptics.selectionAsync();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                className="rounded-md px-0.5 py-0 active:bg-subtle"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  {workflowGroup ? (
                    <>
                      <View className="h-6 w-6 shrink-0 items-center justify-center">
                        <WorkRowIcon
                          row={row}
                          failed={failed}
                          iconSubtleColor={props.iconSubtleColor}
                        />
                      </View>
                      <WorkflowSummary group={workflowGroup} />
                    </>
                  ) : row.live ? (
                    <ShimmeringWorkContent
                      icon={workRowSymbolName(row.icon)}
                      iconSubtleColor={props.iconSubtleColor}
                      label={displayText}
                      showIcon={showIcon}
                    />
                  ) : (
                    <>
                      <View className="h-6 w-6 shrink-0 items-center justify-center">
                        {showIcon ? (
                          <WorkRowIcon
                            row={row}
                            failed={failed}
                            iconSubtleColor={props.iconSubtleColor}
                          />
                        ) : null}
                      </View>
                      <Text
                        className={cn(
                          "min-w-0 flex-1 text-sm text-foreground-muted",
                          iconIsDestructive && "font-t3-medium text-adaptive-rose-600-400",
                        )}
                        numberOfLines={1}
                      >
                        {displayText}
                      </Text>
                    </>
                  )}

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {expanded && canExpand ? (
                <Animated.View
                  entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
                  exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
                  layout={WORK_LOG_LAYOUT_TRANSITION}
                  className="ml-7 overflow-hidden border-l border-adaptive-neutral-300-a60-white-a12 pb-1 pl-3 pt-0.5"
                >
                  {workflowGroup ? <WorkflowRoster group={workflowGroup} /> : null}
                  <ThreadActivityInspector
                    activity={row}
                    currentThreadId={props.currentThreadId}
                    environmentId={props.environmentId}
                    iconColor={props.iconSubtleColor}
                    workflow={workflowGroup?.workflow}
                    workspaceRoot={props.workspaceRoot}
                  />
                </Animated.View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly summary: string;
  readonly summaryKind: ToolGroupSummaryKind;
  readonly hasFailure: boolean;
  readonly shimmer: boolean;
  readonly onToggle: () => void;
}) {
  const accessibilityLabel = props.hasFailure
    ? `${props.summary}, tool call failed`
    : props.summary;
  const icon = toolGroupSummarySymbolName(props.summaryKind);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} ${props.hiddenCount} tool ${props.hiddenCount === 1 ? "call" : "calls"}.`}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0 active:bg-subtle"
      >
        {props.shimmer ? (
          <ShimmeringWorkContent
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={props.summary}
            showIcon
          />
        ) : (
          <>
            <View className="h-6 w-6 items-center justify-center">
              <SymbolView
                name={icon}
                size={14}
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            </View>
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
              {props.summary}
            </Text>
          </>
        )}
        <SymbolView
          name={
            props.expanded
              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
              : { ios: "chevron.down", android: "keyboard_arrow_down" }
          }
          size={11}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

function toolGroupSummarySymbolName(kind: ToolGroupSummaryKind): AppSymbolName {
  switch (kind) {
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "search":
      return { ios: "globe", android: "public" };
    case "code-search":
      return "magnifyingglass";
    case "other":
      return { ios: "wrench", android: "build" };
    case "agent-tool":
      return { ios: "sparkles", android: "auto_awesome" };
    case "tone-tool":
      return { ios: "bolt", android: "bolt" };
    case "dynamic-tool":
    case "update":
    case "mixed":
      return { ios: "hammer", android: "construction" };
  }
}
