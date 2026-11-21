import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorMessage } from "./api";
import {
  bootSlowDelay,
  bootSplashDelays,
  bootSplashRemaining,
  logBootBreakdown,
  markBoot,
} from "./lib/boot";
import type {
  SystemStatus,
  Task,
  TemplateSummary,
  TerminalExitPayload,
  TerminalSessionMeta,
  WorkspaceChangedPayload,
  WorkspaceModules,
} from "./types";
import NavCategories from "./shell/NavCategories";
import WorkspaceSwitcher from "./shell/WorkspaceSwitcher";
import {
  IconBook,
  IconDoc,
  IconDashboard,
  IconFlow,
  IconFolder,
  IconInbox,
  IconLayers,
  AppMark,
  IconBack,
  IconCmd,
  IconSearch,
  IconSettings,
  IconTasks,
  IconTerminal,
  IconTools,
  IconUsers,
  IconWarn,
  type IconProps,
} from "./components/icons";
import { useRecentWorkspaces, useToasts } from "./hooks";
import { useWorkspaceNotifications } from "./hooks/useWorkspaceNotifications";
import { usePulse } from "./hooks/anim";
import { lastSeenVersion, markConnected, rememberVersion } from "./lib/prefs";
import ToastStack from "./shell/ToastStack";
import CommandPalette, { type Command } from "./shell/CommandPalette";
import { QuickNoteModal } from "./components/QuickNote";
import { moduleForView } from "./lib/modules";
import ProjectsHome from "./views/projects";
import { CAT_ALL, categoryItems } from "./lib/categories";
import TemplatesHome from "./views/templates";
import Dashboard from "./views/dashboard";
import Tasks from "./views/tasks";
import Collab from "./views/collab";
import Inbox from "./views/Inbox";
import Specs from "./views/specs";
import Teams from "./views/teams";
import Ledger from "./views/Ledger";
import Search from "./views/Search";
import Tools from "./views/tools";
import TerminalView from "./views/Terminal";
import AgentSessions from "./views/agents";
import Settings from "./views/settings";
import ProjectSettings from "./views/ProjectSettings";
import ConfirmDanger from "./components/ConfirmDanger";
import Scramble from "./components/Scramble";
import ErrorBoundary from "./shell/ErrorBoundary";
import { BootBack, BootExit, BootScreen } from "./shell/Boot";
import { centreOf, motionOff, stashOrigin } from "./lib/fx";
import { EASE_OUT } from "./lib/listMotion";
import { growTo, parkMark, projectCard } from "./lib/transitions";

type View =
  | "projects"
  | "teams"
  | "agents"
  | "templates"
  | "dashboard"
  | "tasks"
  | "collab"
  | "specs"
  | "inbox"
  | "ledger"
  | "search"
  | "tools"
  | "terminal"
  | "settings"
  | "projectSettings";

/**
 * What a `system_status` change was: going into a project (or out of one),
 * trading one open project for another, or a newer read of the one already
 * open. `applyStatus` below is the only reader, and the distinction is the
 * whole reason it takes an argument.
 */
type StatusChange = "enter" | "switch" | "refresh";

const NAV: { view: View; icon: ComponentType<IconProps> }[] = [
  { view: "dashboard", icon: IconDashboard },
  { view: "tasks", icon: IconTasks },
  { view: "collab", icon: IconUsers },
  { view: "specs", icon: IconDoc },
  { view: "inbox", icon: IconInbox },
  { view: "ledger", icon: IconBook },
  { view: "search", icon: IconSearch },
  { view: "tools", icon: IconTools },
  { view: "terminal", icon: IconTerminal },
  // Project-scoped settings (D55): last in the workspace nav, like a
  // conventional settings entry. Machine-wide settings stay in the app nav.
  { view: "projectSettings", icon: IconSettings },
];

/**
 * Does a view need an open workspace? The sidebar renders its two navs from
 * different sources (`NAV` above for the workspace tier, five hand-written
 * buttons for the app tier — their icons and badges differ too much to share),
 * so before D66 there was no one place that listed them all. The command
 * palette needs exactly that. (No count here on purpose — the `View` union is
 * the number, and the one that used to be written out had already drifted.)
 *
 * Typed as `Record<View, …>` on purpose: adding a view without adding it here
 * is a compile error. The alternative — a hand-kept array — is the shape that
 * has silently drifted three times in this repo already (D63).
 */
const VIEW_SCOPE: Record<View, "app" | "workspace"> = {
  projects: "app",
  teams: "app",
  agents: "app",
  templates: "app",
  settings: "app",
  dashboard: "workspace",
  tasks: "workspace",
  collab: "workspace",
  specs: "workspace",
  inbox: "workspace",
  ledger: "workspace",
  search: "workspace",
  tools: "workspace",
  terminal: "workspace",
  projectSettings: "workspace",
};

/**
 * Where a command-palette pick flies to (C211): the sidebar cell for that page,
 * or — when the page lives in the other sidebar — the way out to all projects.
 * Read at the moment of the pick, so it is whatever is on screen then.
 */
function sidebarCell(view: View): Element | null {
  return (
    document.querySelector(`.sidebar [data-view="${view}"]`) ??
    document.querySelector(".sidebar .side-back")
  );
}

/**
 * Global shortcuts (D66, product review §1-14). The label and the binding live in one
 * place so the hint the palette shows cannot drift from the key that actually
 * works — hand-copied lists have drifted three times in this repo (D63).
 *
 * All three carry a modifier. That is what makes them safe to fire while a text
 * field has focus (they insert nothing), which matters because the app is full
 * of text inputs and had no prior "don't intercept while typing" convention to
 * inherit — before D66 every global listener only ever handled Esc.
 */
const SHORTCUT_HINT = {
  palette: "Ctrl+K",
  newTask: "Ctrl+Shift+N",
  note: "Ctrl+Shift+D",
} as const;

/** How long after the last agent hub call the sidebar pulse stays lit. */
const AGENT_LIVE_MS = 3 * 60_000;

/**
 * How long a toast stays before it dismisses itself. The exit animation is
 * `ToastStack`'s business, not this queue's (D65) — the row outlives its own
 * removal there so this TTL stays a pure data concern.
 */
const TOAST_TTL_MS = 8_000;

/**
 * Sidebar count badge. Split out of the nav map purely so it can hold a hook:
 * `usePulse` marks the moment the number *changes*, which is the only thing
 * worth animating — the watcher re-renders this nav on every workspace write,
 * so "animate on render" would twitch the sidebar all day (the `anim.ts` rule).
 * Its Dashboard twin (`StatTile`) has had this since D27; only this copy was
 * bare.
 *
 * Mounted unconditionally and self-hiding at zero, rather than mounted only
 * when `count > 0`. `usePulse` deliberately ignores its first value, so a
 * conditionally-mounted badge could never animate the 0→1 transition — the
 * badge would simply appear, which is the *most* common case and the one
 * worth marking. `StatTile` gets this right for free by living on a panel
 * that is always on screen.
 */
function NavBadge({ count, title }: { count: number; title: string }) {
  // As long as the entry's amber glow (C276), so the class outlives it.
  const bumped = usePulse(count, 620);
  if (count <= 0) return null;
  // One kind since D153: blocked tasks and unread deliveries are both "waiting
  // on you", so both are the amber circle plus the number. (They used to be
  // red and accent; the reasoning that split them is in the `.badge` note in
  // styles.css.)
  return (
    <span className={`badge badge--you${bumped ? " badge--bumped" : ""}`} title={title}>
      <span className="mk-y" aria-hidden="true" />
      <Scramble value={count} />
    </span>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  // Last system_status failure. Before the first successful load this is a
  // boot failure (blocking splash + retry); afterwards refreshes keep the
  // stale-but-usable status and surface a non-blocking banner instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The shell is always present (D46): the projects home is the app's home
  // view and needs no open workspace; workspace views hang below it.
  const [view, setView] = useState<View>("projects");
  const [category, setCategory] = useState<string>(CAT_ALL);
  // Whether the sidebar shows the built-in categories nobody has used yet
  // (r2 3-5). Session state, not a pref: it answers "let me see what template
  // kinds exist", which is a question you ask once and not a standing setting.
  // Incremented whenever the workspace changed (backend watcher event or a
  // local mutation) so child views know to re-read from the source of truth.
  const [refreshKey, setRefreshKey] = useState(0);
  const [agentLive, setAgentLive] = useState(false);
  // Capability modules of the current workspace (null while unknown/no
  // workspace). Gates optional surfaces such as the collab nav entry.
  const [modules, setModules] = useState<WorkspaceModules | null>(null);
  // Project catalog + templates: shared by the sidebar categories and the
  // projects home so both render from the same fetch.
  const { recent, setRecent, reload: reloadRecent } = useRecentWorkspaces();
  // The sidebar logo: where the boot mark flies to (C2).
  const brandMarkRef = useRef<HTMLSpanElement>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  // App-level terminal sessions (D50): drive the sidebar/card running
  // markers and the quit guard. The terminal view reports launches/closes
  // up; natural exits arrive as events.
  // `null` until the first `terminal_list` resolves (D65) — the agent
  // overview needs to tell "no sessions" apart from "not asked yet"; the
  // running markers and quit guard read it as empty either way.
  const [termSessions, setTermSessions] = useState<TerminalSessionMeta[] | null>(null);
  const [quitPrompt, setQuitPrompt] = useState(false);
  // Notification layer (D62): toasts for events someone is waiting on, a
  // silent count for the inbox (the count comes from the notifications hook
  // further down, which owns every announce/read decision).
  const { toasts, pushToast, dismiss } = useToasts(TOAST_TTL_MS);
  // Tool a denial toast asked the catalog to focus (D63). Parked here because
  // the jump crosses views: the toast fires from the shell, the switch lives
  // in Tools. Cleared by Tools once consumed, so it acts exactly once.
  const [focusTool, setFocusTool] = useState<string | null>(null);
  const clearFocusTool = useCallback(() => setFocusTool(null), []);
  // C238: the rename notice's "go to tools" asks the page to bring the shipped
  // assets into view (the rename leaves the guide saying the old name).
  const [focusAssets, setFocusAssets] = useState(false);
  const clearFocusAssets = useCallback(() => setFocusAssets(false), []);
  // Task the command palette asked the task view to reveal (D66). Same parked
  // one-shot shape as focusTool above — still no router, so a jump that has to
  // carry a target keeps its payload here.
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const clearFocusTask = useCallback(() => setFocusTask(null), []);

  // Command palette (D66).
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Record-decision dialog, summoned from the palette or the shortcut. */
  const [noteOpen, setNoteOpen] = useState(false);
  /** Ask the task view to focus its create form; cleared once consumed. */
  const [focusCreate, setFocusCreate] = useState(false);
  const clearFocusCreate = useCallback(() => setFocusCreate(false), []);
  /** Task list for the palette's search. Explicit flag rather than deriving
      loading from `tasks === null`: a failed read also leaves it null, and
      "still loading" forever is worse than "found nothing" (D65's lesson). */
  const [paletteTasks, setPaletteTasks] = useState<Task[] | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  /** Failure from a palette-driven action. Deliberately **not** a toast: the
      strength table governs four known event kinds, and funnelling arbitrary
      errors through it would empty that table of meaning (D62). */
  const [actionError, setActionError] = useState<string | null>(null);
  // The version the last run on this machine had (C197), read once per start.
  const versionBefore = useRef<string | null>(lastSeenVersion());
  const appVersion = status?.appVersion;
  useEffect(() => {
    if (appVersion !== undefined) rememberVersion(appVersion);
  }, [appVersion]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    // Marked here rather than beside the splash on purpose: these measure the
    // work, and holding the splash is not work. Keeping them out of that path
    // is what stops BOOT_MIN_VISIBLE_MS from quietly inflating every number
    // the breakdown reports.
    markBoot("paint");
    void refresh().then(() => {
      markBoot("data");
      logBootBreakdown();
    });
  }, [refresh]);

  // The splash keeps the screen until its minimum showing is up, even once the
  // data is in. Read once on mount (`useState` initialiser, not on every
  // render) so the deadline is fixed at the origin and cannot drift forward.
  const [bootHeld, setBootHeld] = useState(() => bootSplashRemaining() > 0);
  useEffect(() => {
    if (!bootHeld) return;
    const id = window.setTimeout(() => setBootHeld(false), bootSplashRemaining());
    return () => window.clearTimeout(id);
  }, [bootHeld]);

  // A boot that never settles has nothing to click and says nothing. Armed
  // only while `status` is still missing, so it cannot fire during the minimum
  // showing, and cleared the moment the data lands.
  const [bootSlow, setBootSlow] = useState(false);
  useEffect(() => {
    if (status !== null) return;
    const id = window.setTimeout(() => setBootSlow(true), bootSlowDelay());
    return () => window.clearTimeout(id);
  }, [status]);

  // Fixed at mount, and it has to be: these offsets place the animations
  // relative to the document origin, so recomputing them on a later render
  // would move that origin and jump the pulse forward mid-showing. The splash
  // now outlives `status` arriving — which is itself a re-render — so this is
  // a live path, not a hypothetical one.
  const [bootAnim] = useState(bootSplashDelays);

  // C2 plays once, and only if the splash was really on screen — a boot fast
  // enough to skip it has nothing to fly anywhere. A layout effect, so the
  // overlay is in place before the shell's first paint rather than one frame
  // after it.
  const bootShownRef = useRef(false);
  const [bootExit, setBootExit] = useState(false);
  // C227 in progress: the app is on its way out.
  const [quitting, setQuitting] = useState(false);
  useLayoutEffect(() => {
    if (status === null || bootHeld || !bootShownRef.current) return;
    bootShownRef.current = false;
    if (!motionOff()) setBootExit(true);
  }, [status, bootHeld]);

  // Debounced filesystem deltas from the Rust watcher.
  useEffect(() => {
    const unlisten = listen<WorkspaceChangedPayload>("workspace://changed", () => {
      setRefreshKey((k) => k + 1);
      void refresh();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [refresh]);

  const reloadTerminals = useCallback(async () => {
    try {
      setTermSessions(await api.terminalList());
    } catch (e) {
      console.warn("terminal list failed:", e);
    }
  }, []);

  useEffect(() => {
    void reloadTerminals();
    const unExit = listen<TerminalExitPayload>("terminal://exit", (ev) => {
      setTermSessions((cur) =>
        (cur ?? []).map((s) =>
          s.id === ev.payload.id
            ? { ...s, status: "exited", exitCode: ev.payload.exitCode }
            : s,
        ),
      );
    });
    // A pop-out toggle (B16-C) changes popped_out — refresh so the running
    // markers and the agent overview stay in sync across windows.
    const unSessions = listen("terminal://sessions", () => void reloadTerminals());
    return () => {
      void unExit.then((f) => f());
      void unSessions.then((f) => f());
    };
  }, [reloadTerminals]);

  const runningTerms = useMemo(
    () => (termSessions ?? []).filter((s) => s.status === "running"),
    [termSessions],
  );
  const runningRoots = useMemo(
    () => new Set(runningTerms.map((s) => s.root)),
    [runningTerms],
  );

  // Quit guard (D50): closing the app kills every live CLI, so it asks
  // first. Confirm kills them explicitly, then tears the window down.
  const runningCountRef = useRef(0);
  useEffect(() => {
    runningCountRef.current = runningTerms.length;
  }, [runningTerms]);
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      // Always take over: letting the close proceed destroys the window, and
      // on macOS that path segfaults inside WebKit every time (G065). Both
      // branches end at api.quitApp(), which quits the way the OS expects.
      event.preventDefault();
      if (runningCountRef.current > 0) setQuitPrompt(true);
      else void confirmQuit();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  async function confirmQuit() {
    // Persist every restorable session's metadata for restore (D69), then kill
    // the children. Unlike closing tabs one by one, shutdown keeps the files so
    // the next launch restores the tabs (which resume on view, not read-only).
    await api.terminalShutdown().catch(() => {});
    // C227 (D153): the boot played backwards, then the real quit. Skipped
    // under reduced motion — closing is just closing.
    if (!motionOff()) {
      setQuitPrompt(false);
      setQuitting(true);
      return;
    }
    // Quitting is the OS's job, not ours: `quit_app` sends the platform's own
    // shutdown, which takes every window with it — including a pop-out
    // terminal (B16-C), the reason this used to destroy windows by hand.
    // Destroying them one by one is exactly the path that segfaults on macOS
    // (G065), so there is nothing left here to do first.
    await api.quitApp();
  }

  // Agent overview → the workspace's terminal view, opening it on the way
  // if it is not the current one. The session itself never notices.
  //
  // With `from` (the stage, or a project's group) the change is content
  // opening into its detail (C27 / C291): a terminal-dark frame grows from it
  // to the terminal. The workspace is opened first, while the old page still
  // shows, so a failed open stays on this page with its error and no frame;
  // the switch and the page change are then one swap under the picture, and
  // where it lands is still applyStatus' decision (invariant 19).
  async function openTerminalOf(root: string, from?: Element | null) {
    let switched: SystemStatus | null = null;
    if (wsRoot !== root) {
      try {
        switched = await api.openWorkspace(root);
      } catch (e) {
        setLoadError(errorMessage(e));
        return;
      }
    }
    const swap = () => {
      if (switched !== null) applySwitched(switched);
      setView("terminal");
    };
    if (from == null) {
      swap();
      return;
    }
    void growTo(
      { from, to: () => document.querySelector('[data-vt="term"]'), look: "term" },
      swap,
    );
  }

  /** Terminal → agent overview folds the page back into the stage it grew
   *  from (C27's return); any other way in is a plain page change. */
  function goToAgents() {
    if (view !== "terminal") {
      setView("agents");
      return;
    }
    void growTo(
      { from: null, back: true, look: "term", to: () => document.querySelector("[data-stage]") },
      () => setView("agents"),
    );
  }

  // Catalog and template list re-read whenever the home is (re)entered —
  // the templates view can add custom templates and any open/create touches
  // the registry, so coming back is the natural refresh point.
  useEffect(() => {
    if (view !== "projects") return;
    reloadRecent();
    api
      .listTemplates()
      .then(setTemplates)
      .catch((e) => {
        // Categories degrade to All / Custom / No template — the catalog still works.
        console.warn("template list failed:", e);
      });
  }, [view, reloadRecent]);

  // Modules re-read on watcher deltas (modules.json is whitelisted) and reset
  // on workspace switch/close so one workspace's modules never leak into the
  // next. Local toggles (Settings) update the state directly via setModules.
  const wsRoot = status?.workspace?.root ?? null;

  // The workspace sidebar's "phase · template" line reads the overview list. A
  // phase advance arrives as a refreshKey bump, so re-read it then — trailing
  // and coalesced, because an agent at work bumps refreshKey in bursts.
  useEffect(() => {
    if (wsRoot === null) return;
    const id = window.setTimeout(reloadRecent, 1200);
    return () => window.clearTimeout(id);
  }, [wsRoot, refreshKey, reloadRecent]);
  const modulesRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (modulesRootRef.current !== wsRoot) {
      modulesRootRef.current = wsRoot;
      setModules(null);
    }
    if (wsRoot === null) return;
    let cancelled = false;
    api
      .modulesGet()
      .then((m) => {
        if (!cancelled) setModules(m);
      })
      .catch((e) => {
        console.warn("modules_get failed:", e);
        if (!cancelled) setModules(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wsRoot, refreshKey]);

  const workspaceLoaded = status?.workspace != null;
  const moduleOn = useCallback(
    (id: string) => modules?.enabled.includes(id) ?? false,
    [modules],
  );

  // D78: workspace-open housekeeping — sweep aged verified-done tasks into
  // the archive on every open (every open path funnels through wsRoot; the
  // ref resets on close so re-opening the same root sweeps again — the
  // guard only dedupes the renders *within* one open). The core honors the
  // per-workspace switch so this call is unconditional; failures stay
  // silent (housekeeping must never block an open) and an actual sweep
  // surfaces via the watcher refresh.
  const sweptRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (wsRoot === null) {
      sweptRootRef.current = null;
      return;
    }
    if (sweptRootRef.current === wsRoot) return;
    sweptRootRef.current = wsRoot;
    api.autoArchiveSweep().catch((e) => console.warn("auto_archive_sweep failed:", e));
  }, [wsRoot]);

  // A module switched off closes its view: fall back to the dashboard.
  useEffect(() => {
    const owner = moduleForView(view);
    if (owner !== null && modules !== null && !modules.enabled.includes(owner)) {
      setView("dashboard");
    }
  }, [view, modules]);

  // No open workspace → only the app-level views (home, teams, agent
  // overview, settings) are valid.
  useEffect(() => {
    if (
      status !== null &&
      !workspaceLoaded &&
      view !== "projects" &&
      view !== "teams" &&
      view !== "agents" &&
      view !== "templates" &&
      view !== "settings"
    ) {
      setView("projects");
    }
  }, [status, workspaceLoaded, view]);

  // Sidebar "agent live" pulse: lit while the ledger tail shows a recent
  // agent hub call. Diff comes from the files themselves (source of truth).
  useEffect(() => {
    if (!workspaceLoaded) {
      setAgentLive(false);
      return;
    }
    let timer: number | undefined;
    let cancelled = false;
    api
      .recentEvents(30)
      .then((events) => {
        if (cancelled) return;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].kind === "agent_tool_called") {
            // Any hub call at all — allowed or denied — proves the wiring
            // works, which retires the connect guide for good (D63).
            if (wsRoot !== null) markConnected(wsRoot);
            const age = Date.now() - new Date(events[i].at).getTime();
            if (age < AGENT_LIVE_MS) {
              setAgentLive(true);
              timer = window.setTimeout(
                () => setAgentLive(false),
                AGENT_LIVE_MS - age,
              );
            } else {
              setAgentLive(false);
            }
            return;
          }
        }
        setAgentLive(false);
      })
      .catch((e) => {
        console.warn("recent events failed:", e);
        setAgentLive(false);
      });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workspaceLoaded, refreshKey, wsRoot]);

  // Notification orchestration (D62/D63/D71) — six effects and the five refs
  // that coordinate them live in their own module; the shell keeps only the
  // count it renders.
  const { inboxUnseen } = useWorkspaceNotifications({
    wsRoot,
    refreshKey,
    status,
    moduleOn,
    inboxOnScreen: view === "inbox",
    pushToast,
    t,
    openInbox: () => setView("inbox"),
    openProjects: () => setView("projects"),
    // C173: the page grows out of the toast, and the toast's amber circle
    // stays behind for the tools page to fly to the switch.
    authorizeTool: (tool, from) => {
      const swap = () => {
        setFocusTool(tool);
        setView("tools");
      };
      parkMark(centreOf(from?.querySelector(".toast-mk")));
      if (from === null) {
        swap();
        return;
      }
      void growTo({ from, to: () => document.querySelector("main.content .view"), look: "panel" }, swap);
    },
  });

  /**
   * Global Ctrl/⌘+K.
   *
   * Bound on **bubble**, deliberately. xterm binds keydown on its hidden
   * textarea in the *capture* phase and calls `stopPropagation()`, turning
   * Ctrl+K into readline's "kill to end of line" and sending \x0B down the PTY
   * — so with a bubble listener the terminal simply never lets this fire, and
   * the CLI keeps its full keymap (D66 decided: yield to the CLI while the
   * terminal has focus). The
   * granularity that falls out of it is exactly right: focus parked on a
   * terminal *tab* still opens the palette; only typing into the terminal
   * itself does not.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const key = e.key.toLowerCase();

      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (!e.shiftKey) return;
      // Both of these write into the open workspace; with none open they would
      // land on a view the shell immediately bounces back to All projects.
      if (wsRoot === null) return;
      if (key === "n") {
        e.preventDefault();
        setFocusCreate(true);
        setView("tasks");
      } else if (key === "d") {
        e.preventDefault();
        setNoteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wsRoot]);

  /** Tasks are read per opening, not held: they go stale the moment an agent
      writes, and the palette is the only thing that wants the whole list. */
  useEffect(() => {
    if (!paletteOpen) return;
    if (wsRoot === null) {
      setPaletteTasks(null);
      return;
    }
    let cancelled = false;
    setTasksLoading(true);
    void (async () => {
      try {
        const rows = await api.listTasks();
        if (!cancelled) setPaletteTasks(rows);
      } catch (e) {
        // Navigation still works without them; don't hold the palette hostage.
        console.warn("palette task load failed:", e);
      } finally {
        if (!cancelled) setTasksLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, wsRoot, refreshKey]);

  const onMutated = useCallback(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every open/create/switch/close funnels through here. Where it leaves you
   * comes from the *action*, not from the result — reading it off
   * `s.workspace` alone treats those as one question, and that is what used
   * to throw you to the dashboard every time you changed project.
   *
   *   "enter"  — you asked to go into a project, or out of one: the
   *              dashboard, or the projects home when nothing is open.
   *   "switch" — you asked for a different project, not a different page, so
   *              the page stays. Switching changes the subject, not the task;
   *              comparing two projects' task lists should not cost a detour
   *              through the dashboard each way.
   *
   * A kept page the new project cannot show is not this function's problem:
   * the two self-correcting effects above already pull you off a module-gated
   * view whose module is off over there, and off any workspace view when
   * nothing is open.
   */
  const applyStatus = useCallback((s: SystemStatus, action: StatusChange = "enter") => {
    setStatus(s);
    if (action === "enter") setView(s.workspace ? "dashboard" : "projects");
    setRefreshKey((k) => k + 1);
  }, []);
  const applySwitched = useCallback(
    (s: SystemStatus) => applyStatus(s, "switch"),
    [applyStatus],
  );
  const applyRefreshed = useCallback(
    (s: SystemStatus) => applyStatus(s, "refresh"),
    [applyStatus],
  );

  const paletteCommands = useMemo<Command[]>(() => {
    if (status === null) return [];
    const out: Command[] = [];
    const wsOpen = status.workspace !== null;
    const here = status.workspace?.root ?? null;

    // Navigation: the same module gating and the same "without an open
    // workspace there is only the app layer" rule that App's two
    // self-correcting effects use — the palette shouldn't offer a
    // destination that bounces straight back when you press it.
    for (const key of Object.keys(VIEW_SCOPE) as View[]) {
      if (VIEW_SCOPE[key] === "workspace" && !wsOpen) continue;
      const owner = moduleForView(key);
      if (owner !== null && !moduleOn(owner)) continue;
      if (key === view) continue; // already on this page
      out.push({
        id: `view:${key}`,
        group: t("cmdk.groupNav"),
        title: t(`nav.${key}`),
        flyTo: () => sidebarCell(key),
        // From inside a workspace the palette is the only way to the agent
        // overview (that sidebar has no app-level entries), so it takes the
        // same fold-back into the stage (C27's return).
        run: () => (key === "agents" ? goToAgents() : setView(key)),
      });
    }

    // Switching projects. While `recent` is null (not read yet) this pass
    // is empty, but the palette's loading flag is true at the same time, so
    // "no matches" is never announced before the answer is in
    // (invariant 10).
    for (const ws of recent ?? []) {
      if (ws.root === here) continue;
      out.push({
        id: `ws:${ws.root}`,
        group: t("cmdk.groupProjects"),
        title: ws.name,
        hint: ws.root,
        flyTo: () => document.querySelector(".switcher-trigger") ?? sidebarCell("projects"),
        run: () => {
          void (async () => {
            setActionError(null);
            try {
              applyStatus(await api.openWorkspace(ws.root));
            } catch (e) {
              setActionError(errorMessage(e));
            }
          })();
        },
      });
    }

    // Actions: offered only when a workspace is open — both write into that
    // workspace's .nextup/.
    if (wsOpen) {
      out.push({
        id: "act:newTask",
        group: t("cmdk.groupActions"),
        title: t("tasks.newTitle"),
        hint: SHORTCUT_HINT.newTask,
        flyTo: () => sidebarCell("tasks"),
        run: () => {
          setFocusCreate(true);
          setView("tasks");
        },
      });
      out.push({
        id: "act:note",
        group: t("cmdk.groupActions"),
        title: t("note.addDecision"),
        hint: SHORTCUT_HINT.note,
        opensDialog: true,
        run: () => setNoteOpen(true),
      });
    }

    for (const task of paletteTasks ?? []) {
      if (task.archived) continue;
      out.push({
        id: `task:${task.id}`,
        group: t("cmdk.groupTasks"),
        title: task.title,
        hint: t(`status.${task.status}`),
        keywords: `${task.id} ${task.tags.join(" ")}`,
        searchOnly: true,
        flyTo: () => sidebarCell("tasks"),
        run: () => {
          setFocusTask(task.id);
          setView("tasks");
        },
      });
    }

    return out;
  }, [status, recent, paletteTasks, view, t, moduleOn, applyStatus]);

  /**
   * A workspace page change from the sidebar. Dashboard ⇄ tasks is content
   * opening into its detail (C23, D153): the task overview grows into the
   * task list, and folds back into it on the way out. Every other move is a
   * plain page change.
   */
  function goTo(v: View) {
    if (view === "dashboard" && v === "tasks") {
      void growTo(
        {
          from: document.querySelector('[data-vt="stats"]'),
          to: () => document.querySelector('[data-vt="tklist"]'),
          look: "panel",
        },
        () => setView(v),
      );
      return;
    }
    if (view === "tasks" && v === "dashboard") {
      void growTo(
        { from: null, back: true, look: "panel", to: () => document.querySelector('[data-vt="stats"]') },
        () => setView(v),
      );
      return;
    }
    // C41: entering the inbox through its badge, the amber light starts at
    // the badge and runs to each unread envelope once they are on screen.
    if (v === "inbox" && view !== "inbox" && inboxUnseen > 0) {
      stashOrigin("inbox", centreOf(document.querySelector('.sidebar [data-view="inbox"] .badge .mk-y')));
    }
    setView(v);
  }

  /**
   * The top error line's Close (my-design review F6): it lifts away, then the
   * page slides back up into the room it took — the way it came in (barDrop)
   * run backwards. Reduced motion: gone at once.
   */
  function dismissActionError(bar: HTMLElement | null) {
    if (bar === null || motionOff()) {
      setActionError(null);
      return;
    }
    const page = document.querySelector<HTMLElement>("main.content .view");
    const before = page?.getBoundingClientRect().top;
    const out = bar.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-8px)" },
      ],
      { duration: 200, easing: "ease-in", fill: "forwards" },
    );
    void out.finished
      .catch(() => undefined)
      .then(() => {
        flushSync(() => setActionError(null));
        const after = page?.getBoundingClientRect().top;
        if (page == null || before === undefined || after === undefined || Math.abs(before - after) < 1) return;
        page.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], {
          duration: 320,
          easing: EASE_OUT,
        });
      });
  }

  function showCategory(id: string) {
    setCategory(id);
    setView("projects");
  }

  if (status === null || bootHeld) {
    // Not a second loading screen: the same splash, under the same classes,
    // that index.html painted and createRoot() has just cleared. Two gaps sit
    // back to back at startup — the bundle download and then the first IPC
    // round trip — and one splash spanning both makes it one wait, not two
    // events. Reached with `status` already loaded whenever the minimum showing
    // has not run out; that is the intended case (BOOT_MIN_VISIBLE_MS).
    //
    // A true boot failure stays on this screen too (C226): the error takes the
    // place the slow notice would, with a retry, and the mark stops beating.
    // It is checked ahead of the hold — a splash that keeps running over a
    // known failure is just a delay before bad news.
    //
    // The slow notice is appended rather than swapped in: the wait has not
    // ended and the app has learned nothing about why, so the screen should
    // not change its mind about what it is. It adds a way out, not a verdict.
    bootShownRef.current = true;
    return (
      <BootScreen
        delays={bootAnim}
        label={t("common.loading")}
        slow={bootSlow && status === null}
        slowText={t("common.bootSlow")}
        error={status === null ? loadError : null}
        retryLabel={t("common.retry")}
        onRetry={() => void refresh()}
      />
    );
  }

  const blocked = status.taskCounts?.blocked ?? 0;
  const cats = categoryItems(recent ?? [], templates, t).filter((c) => c.id !== CAT_ALL);
  // Built-ins and the custom bucket are always listed, so an emptied
  // selection just shows the empty-category message. Only "No template" can
  // vanish from the rail entirely — fall back to "All" instead of leaving a
  // dead filter.
  const activeCategory =
    category === CAT_ALL || cats.some((c) => c.id === category) ? category : CAT_ALL;
  const inWorkspace = status.workspace !== null && VIEW_SCOPE[view] === "workspace";
  // The switcher's second line (D153): "phase · template", from the same
  // overview list the projects page reads — no extra IPC for it.
  const wsOverview = recent?.find((w) => w.root === wsRoot) ?? null;
  const wsMeta =
    wsOverview === null
      ? null
      : [
          wsOverview.ongoing ? t("workflow.ongoing") : (wsOverview.currentPhaseTitle ?? wsOverview.currentPhase),
          wsOverview.templateName,
        ]
          .filter((x): x is string => typeof x === "string" && x !== "")
          .join(" · ") || null;

  return (
    <div className="shell">
      {/* Two sidebars (D153): the app tier while you are looking at something
          that spans projects, the project's own ten pages once you are inside
          one. Which one shows follows the page, not whether a workspace
          happens to be open — Settings with a project open is still an app
          page. */}
      <aside className={`sidebar ${inWorkspace ? "sidebar--ws" : "sidebar--app"}`}>
        <div className="brand">
          <span className="brand-mark" ref={brandMarkRef}>
            <AppMark size={26} />
          </span>
          <span className="brand-name">{t("app.name")}</span>
        </div>

        {/* Middle region scrolls on short windows; brand and foot stay pinned. */}
        <div className="sidebar-scroll">
          {inWorkspace && status.workspace !== null ? (
            <div className="sidebar-ws">
              <button
                className="side-back"
                onClick={() => {
                  // C13 backwards: the project folds back into its card.
                  const root = wsRoot;
                  void growTo(
                    {
                      from: null,
                      back: true,
                      look: "card",
                      to: () => projectCard(root),
                    },
                    () => showCategory(CAT_ALL),
                  );
                }}
              >
                <IconBack size={15} className="nav-icon" />
                {t("nav.allProjects")}
              </button>
              <WorkspaceSwitcher
                workspace={status.workspace}
                meta={wsMeta}
                onSwitched={applySwitched}
                onSeeAll={() => showCategory(CAT_ALL)}
              />
              <nav className="nav">
                <div className="nav-label">{t("nav.section")}</div>
                {NAV.filter(({ view: v }) => {
                  const owner = moduleForView(v);
                  return owner === null || moduleOn(owner);
                }).map(({ view: v, icon: Icon }) => (
                  <button
                    key={v}
                    data-view={v}
                    className={`nav-item ${view === v ? "active" : ""}`}
                    onClick={() => goTo(v)}
                  >
                    <Icon size={17} className="nav-icon" />
                    {t(`nav.${v}`)}
                    {v === "tasks" && <NavBadge count={blocked} title={t("status.blocked")} />}
                    {v === "inbox" && (
                      <NavBadge count={inboxUnseen} title={t("notify.unreadDeliveries")} />
                    )}
                    {v === "terminal" && wsRoot !== null && runningRoots.has(wsRoot) && (
                      <span className="badge nav-run" title={t("term.runningMark")}>
                        <span className="dot-run amb" role="img" aria-label={t("term.runningMark")} />
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </div>
          ) : (
            <nav className="nav nav--home">
              <button
                data-view="projects"
                className={`nav-item ${view === "projects" ? "active" : ""}`}
                onClick={() => showCategory(CAT_ALL)}
              >
                <IconFolder size={17} className="nav-icon" />
                {t("welcome.projectsTitle")}
              </button>
              {/* The directory only unfolds on the projects page (D46). Until
                  the overview has been read the counts are unknown, not zero
                  (invariant 10): the cells stay blank and the fold row waits. */}
              {view === "projects" && (
                <NavCategories
                  cats={cats}
                  total={recent === null ? null : recent.length}
                  active={activeCategory}
                  onSelect={showCategory}
                />
              )}
              {/* Teams live at the app level like the projects home (D48): the
                  graph spans workspaces, so it needs none open. */}
              <button
                data-view="teams"
                className={`nav-item ${view === "teams" ? "active" : ""}`}
                onClick={() => setView("teams")}
              >
                <IconFlow size={17} className="nav-icon" />
                {t("nav.teams")}
              </button>
              {/* Agent overview is app-level too (D50): sessions span projects
                  and keep running while none of them is open. */}
              <button
                data-view="agents"
                className={`nav-item ${view === "agents" ? "active" : ""}`}
                onClick={goToAgents}
              >
                <IconTerminal size={17} className="nav-icon" />
                {t("nav.agents")}
                {runningTerms.length > 0 && (
                  <span className="badge" title={t("term.runningMark")}>
                    <span className="dot-run amb" aria-hidden="true" />
                    {runningTerms.length}
                  </span>
                )}
              </button>
              {/* Workflow templates are a first-class machine-wide asset (D51):
                  promoted out of Settings into their own app-level view. */}
              <button
                data-view="templates"
                className={`nav-item ${view === "templates" ? "active" : ""}`}
                onClick={() => setView("templates")}
              >
                <IconLayers size={17} className="nav-icon" />
                {t("nav.templates")}
              </button>
              {/* Settings are app-level too (D49): language/theme are
                  machine-wide, so the page must not require an open workspace. */}
              <button
                data-view="settings"
                className={`nav-item ${view === "settings" ? "active" : ""}`}
                onClick={() => setView("settings")}
              >
                <IconSettings size={17} className="nav-icon" />
                {t("nav.settings")}
              </button>
            </nav>
          )}
        </div>

        <div className="sidebar-foot">
          {inWorkspace && agentLive && (
            <span className="agent-live">
              <span className="agent-live-dot amb" aria-hidden="true" />
              {t("app.agentLive")}
            </span>
          )}
          {/* A shortcut-only feature may as well not exist — nothing on
              screen ever mentions it. This button is both the entry point and
              the documentation (in-app help proper is B9's job; all this does
              is make Ctrl+K visible). */}
          <button className="nav-item cmdk-open" onClick={() => setPaletteOpen(true)}>
            <IconCmd size={15} className="nav-icon" />
            <span className="cmdk-open-label">{t("cmdk.label")}</span>
            <kbd>{SHORTCUT_HINT.palette}</kbd>
          </button>
          {/* C197: after an update, the number settles from the old version
              into the new one — once, on the first start of the new version. */}
          <Scramble
            className="side-ver"
            value={`v${status.appVersion}`}
            initial={versionBefore.current === null ? undefined : `v${versionBefore.current}`}
            durationMs={760}
          />
        </div>
      </aside>

      <main className="content">
        {/* The page's own error bars (D153): above the page header, each with
            a warning mark; they drop in from above (C29). Sticky, so the
            message stays in view while the page scrolls (invariant 16(c)). */}
        {(loadError !== null || actionError !== null) && (
          <div className="top-bars">
            {loadError !== null && (
              <div className="top-bar" role="alert">
                <IconWarn size={15} />
                <span>
                  {t("app.refreshFailed")} {loadError}
                </span>
              </div>
            )}
            {actionError !== null && (
              <div className="top-bar" role="alert">
                <IconWarn size={15} />
                <span>{actionError}</span>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={(e) => dismissActionError(e.currentTarget.closest<HTMLElement>(".top-bar"))}
                >
                  {t("common.close")}
                </button>
              </div>
            )}
          </div>
        )}
        {/* One view crashing shouldn't take the whole window with it
            (reported during the D66 walkthrough: the canvas's render loop
            blacked out the entire app). The shell — sidebar, switcher,
            nav — is deliberately kept **outside** the boundary: when a view
            dies, the way out of it has to stay alive. */}
        <ErrorBoundary
          resetKey={view}
          title={t("app.viewCrashed")}
          hint={t("app.viewCrashedHint")}
          retryLabel={t("common.retry")}
        >
          {view === "projects" && (
            <ProjectsHome
              overview={recent}
              onOverviewChange={setRecent}
              templates={templates}
              category={activeCategory}
              onClearCategory={() => setCategory(CAT_ALL)}
              onLoaded={applyStatus}
              sessions={runningTerms}
            />
          )}
          {view === "teams" && <Teams refreshKey={refreshKey} pushToast={pushToast} />}
          {view === "agents" && (
            <AgentSessions
              sessions={termSessions}
              overview={recent}
              onOpen={(root, from) => void openTerminalOf(root, from)}
              onSessionsChanged={() => void reloadTerminals()}
            />
          )}
          {view === "templates" && <TemplatesHome />}
          {view === "settings" && (
            <Settings
              status={status}
              onGoToProjectSettings={
                workspaceLoaded ? () => setView("projectSettings") : undefined
              }
            />
          )}
          {workspaceLoaded && (
            // Keyed by root: every workspace view remounts when the project
            // changes, so a view's own state cannot outlive the project it
            // was read from. Until switching kept your page this came free —
            // every switch landed on the dashboard, which unmounted whatever
            // you had been looking at. Now it has to be said out loud, and
            // the cost of leaving it unsaid is not a stale list: Specs holds
            // the selected spec's id *and its rendered body*, Inbox holds the
            // opened envelope, Tools holds the last doctor report, Terminal
            // holds the active tab (D69 path B). Carried across a switch,
            // each of those shows one project's content under another
            // project's name — which is why TerminalView's own key, the one
            // an adversarial review asked for, is this block's job now
            // rather than a second statement of the same rule.
            <Fragment key={wsRoot ?? ""}>
              {view === "dashboard" && (
                <Dashboard
                  status={status}
                  refreshKey={refreshKey}
                  onMutated={onMutated}
                  onShowLedger={() => setView("ledger")}
                  onGoToTools={() => setView("tools")}
                  onGoToTerminal={() => setView("terminal")}
                  terminalRunning={wsRoot !== null && runningRoots.has(wsRoot)}
                  onGoToTasks={() => setView("tasks")}
                  onRecordDecision={() => setNoteOpen(true)}
                />
              )}
              {view === "tasks" && (
                <Tasks
                  refreshKey={refreshKey}
                  onMutated={onMutated}
                  focusTask={focusTask}
                  onFocusHandled={clearFocusTask}
                  focusCreate={focusCreate}
                  onCreateHandled={clearFocusCreate}
                />
              )}
              {view === "collab" && <Collab refreshKey={refreshKey} onMutated={onMutated} />}
              {view === "specs" && <Specs refreshKey={refreshKey} />}
              {view === "inbox" && (
                <Inbox
                  root={status.workspace?.root ?? ""}
                  refreshKey={refreshKey}
                  onMutated={onMutated}
                  onGoToTasks={() => setView("tasks")}
                />
              )}
              {view === "ledger" && <Ledger refreshKey={refreshKey} onMutated={onMutated} />}
              {view === "search" && <Search refreshKey={refreshKey} />}
              {view === "tools" && (
                <Tools
                  refreshKey={refreshKey}
                  focusTool={focusTool}
                  onFocusHandled={clearFocusTool}
                  focusAssets={focusAssets}
                  onAssetsFocused={clearFocusAssets}
                />
              )}
              {view === "terminal" && (
                <TerminalView
                  root={status.workspace?.root ?? ""}
                  projectName={status.workspace?.name ?? ""}
                  onSessionsChanged={reloadTerminals}
                />
              )}
              {view === "projectSettings" && (
                <ProjectSettings
                  status={status}
                  onStatusChange={applyStatus}
                  onStatusRefreshed={applyRefreshed}
                  modules={modules}
                  onModulesChange={setModules}
                  onGoToAppSettings={() => setView("settings")}
                  onGoToTools={() => {
                    setFocusAssets(true);
                    setView("tools");
                  }}
                />
              )}
            </Fragment>
          )}
        </ErrorBoundary>
      </main>

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          loading={tasksLoading || recent === null}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {noteOpen && workspaceLoaded && (
        <QuickNoteModal onClose={() => setNoteOpen(false)} onSaved={onMutated} />
      )}

      <ToastStack toasts={toasts} ttlMs={TOAST_TTL_MS} onDismiss={dismiss} />

      {bootExit && <BootExit target={brandMarkRef} onDone={() => setBootExit(false)} />}

      {quitting && <BootBack from={brandMarkRef} onDone={() => void api.quitApp()} />}

      {quitPrompt && (
        <ConfirmDanger
          heading={t("term.quitHeading")}
          body={t("term.quitBody", { n: runningTerms.length })}
          confirmLabel={t("term.quitAction")}
          onConfirm={() => void confirmQuit()}
          onCancel={() => setQuitPrompt(false)}
        />
      )}
    </div>
  );
}
