import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

import { api, errorMessage } from "./api";
import { logBootBreakdown, markBoot } from "./lib/boot";
import type {
  SystemStatus,
  Task,
  TemplateSummary,
  TerminalExitPayload,
  TerminalSessionMeta,
  WorkspaceChangedPayload,
  WorkspaceModules,
} from "./types";
import WorkspaceSwitcher from "./shell/WorkspaceSwitcher";
import {
  IconBook,
  IconDoc,
  IconDashboard,
  IconFlow,
  IconFolder,
  IconInbox,
  IconLayers,
  IconLogo,
  IconSearch,
  IconSettings,
  IconTasks,
  IconTerminal,
  IconTools,
  IconUsers,
  type IconProps,
} from "./components/icons";
import { useRecentWorkspaces, useToasts } from "./hooks";
import { useWorkspaceNotifications } from "./hooks/useWorkspaceNotifications";
import { usePulse } from "./hooks/anim";
import { markConnected } from "./lib/prefs";
import ToastStack from "./shell/ToastStack";
import CommandPalette, { type Command } from "./shell/CommandPalette";
import { QuickNoteModal } from "./components/QuickNote";
import { moduleForView } from "./lib/modules";
import ProjectsHome from "./views/projects";
import { CAT_ALL, categoryItems } from "./lib/categories";
import TemplatesHome from "./views/templates";
import Dashboard from "./views/dashboard";
import Tasks from "./views/Tasks";
import Collab from "./views/Collab";
import Inbox from "./views/Inbox";
import Specs from "./views/Specs";
import Teams from "./views/teams";
import Ledger from "./views/Ledger";
import Search from "./views/Search";
import Tools from "./views/Tools";
import TerminalView from "./views/Terminal";
import AgentSessions from "./views/AgentSessions";
import Settings from "./views/settings";
import ProjectSettings from "./views/ProjectSettings";
import ConfirmDanger from "./components/ConfirmDanger";
import ErrorBoundary from "./shell/ErrorBoundary";

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
function NavBadge({
  count,
  title,
  tone = "warn",
}: {
  count: number;
  title: string;
  /** `warn` = something is stuck (red); `event` = something arrived (accent).
   *  See the `.nav-item .badge` note in styles.css for why they differ. */
  tone?: "warn" | "event";
}) {
  const bumped = usePulse(count);
  if (count <= 0) return null;
  return (
    <span
      className={`badge${tone === "event" ? " badge--event" : ""}${bumped ? " badge--bumped" : ""}`}
      title={title}
    >
      {count}
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
  const [catsExpanded, setCatsExpanded] = useState(false);
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

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    markBoot("paint");
    void refresh().then(() => {
      markBoot("data");
      logBootBreakdown();
    });
  }, [refresh]);

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
      if (runningCountRef.current > 0) {
        event.preventDefault();
        setQuitPrompt(true);
      }
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
    // Tear down every window, not just this one — a pop-out terminal (B16-C)
    // would otherwise keep the app alive after the main window is gone. Close
    // the pop-outs first, then this window last.
    const current = getCurrentWindow();
    const windows = await getAllWebviewWindows().catch(() => []);
    await Promise.allSettled(
      windows.filter((w) => w.label !== current.label).map((w) => w.destroy()),
    );
    await current.destroy();
  }

  // Agent overview → the workspace's terminal view, opening it on the way
  // if it is not the current one. The session itself never notices.
  async function openTerminalOf(root: string) {
    if (wsRoot !== root) {
      try {
        setStatus(await api.openWorkspace(root));
      } catch (e) {
        setLoadError(errorMessage(e));
        return;
      }
      setRefreshKey((k) => k + 1);
    }
    setView("terminal");
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
    authorizeTool: (tool) => {
      setFocusTool(tool);
      setView("tools");
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

  // Open/create/switch/close all land here: into the dashboard when a
  // workspace is loaded, back home when it was closed.
  const applyStatus = useCallback((s: SystemStatus) => {
    setStatus(s);
    setView(s.workspace ? "dashboard" : "projects");
    setRefreshKey((k) => k + 1);
  }, []);

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
        run: () => setView(key),
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
        run: () => {
          setFocusTask(task.id);
          setView("tasks");
        },
      });
    }

    return out;
  }, [status, recent, paletteTasks, view, t, moduleOn, applyStatus]);

  function showCategory(id: string) {
    setCategory(id);
    setView("projects");
  }

  if (status === null) {
    // True boot failure: nothing to show yet, so block with a retry.
    if (loadError !== null) {
      return (
        <div className="splash" style={{ flexDirection: "column", gap: "var(--s-3)" }}>
          <div className="alert alert-error">{loadError}</div>
          <button className="btn" onClick={() => void refresh()}>
            {t("common.retry")}
          </button>
        </div>
      );
    }
    return <div className="splash muted">{t("common.loading")}</div>;
  }

  const blocked = status.taskCounts?.blocked ?? 0;
  const cats = categoryItems(recent ?? [], templates, t).filter((c) => c.id !== CAT_ALL);
  // Built-ins and the custom bucket are always listed, so an emptied
  // selection just shows the empty-category message. Only "No template" can
  // vanish from the rail entirely — fall back to "All" instead of leaving a
  // dead filter.
  const activeCategory =
    category === CAT_ALL || cats.some((c) => c.id === category) ? category : CAT_ALL;
  // Every built-in is always *listed* (above) — but on a catalog where they
  // are mostly unused that meant four permanent "0" rows in the sidebar,
  // pushing the workspace nav below the fold for nothing (r2 3-5). The empty
  // ones fold behind one row instead. The selected category is never folded
  // away, which is what keeps "an emptied selection shows the empty-category
  // message" true rather than turning into a filter that vanished.
  const catsShown = catsExpanded
    ? cats
    : cats.filter((c) => c.count > 0 || c.id === activeCategory);
  const catsFolded = cats.length - catsShown.length;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <IconLogo size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">{t("app.name")}</div>
          </div>
        </div>

        {/* Middle region scrolls on short windows; brand and foot stay pinned. */}
        <div className="sidebar-scroll">
        <nav className="nav nav--home">
          <button
            className={`nav-item ${view === "projects" && activeCategory === CAT_ALL ? "active" : ""}`}
            onClick={() => showCategory(CAT_ALL)}
          >
            <IconFolder size={17} className="nav-icon" />
            {t("welcome.projectsTitle")}
          </button>
          {/* Inside a project the directory folds away (D46) — the home
              item stays as the way back; re-entering it expands the list. */}
          {view === "projects" &&
            catsShown.map((c) => (
              <button
                key={c.id}
                className={`nav-item nav-sub ${activeCategory === c.id ? "active" : ""}`}
                onClick={() => showCategory(c.id)}
              >
                <span className="nav-sub-label">{c.label}</span>
                <span className="nav-count">{c.count}</span>
              </button>
            ))}
          {view === "projects" && (catsFolded > 0 || catsExpanded) && (
            <button
              className="nav-item nav-sub nav-sub-more"
              onClick={() => setCatsExpanded((v) => !v)}
            >
              <span className="nav-sub-label">
                {catsExpanded ? t("welcome.catFewer") : t("welcome.catMore", { n: catsFolded })}
              </span>
            </button>
          )}
          {/* Teams live at the app level like the projects home (D48): the
              graph spans workspaces, so it needs none open. */}
          <button
            className={`nav-item ${view === "teams" ? "active" : ""}`}
            onClick={() => setView("teams")}
          >
            <IconFlow size={17} className="nav-icon" />
            {t("nav.teams")}
          </button>
          {/* Agent overview is app-level too (D50): sessions span projects
              and keep running while none of them is open. */}
          <button
            className={`nav-item ${view === "agents" ? "active" : ""}`}
            onClick={() => setView("agents")}
          >
            <IconTerminal size={17} className="nav-icon" />
            {t("nav.agents")}
            {runningTerms.length > 0 && (
              <span className="badge" title={t("term.runningMark")}>
                {runningTerms.length}
              </span>
            )}
          </button>
          {/* Workflow templates are a first-class machine-wide asset (D51):
              promoted out of Settings into their own app-level view. */}
          <button
            className={`nav-item ${view === "templates" ? "active" : ""}`}
            onClick={() => setView("templates")}
          >
            <IconLayers size={17} className="nav-icon" />
            {t("nav.templates")}
          </button>
          {/* Settings are app-level too (D49): language/theme are
              machine-wide, so the page must not require an open workspace. */}
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <IconSettings size={17} className="nav-icon" />
            {t("nav.settings")}
          </button>
        </nav>

        {status.workspace !== null && (
          <div className="sidebar-ws">
            <WorkspaceSwitcher workspace={status.workspace} onSwitched={applyStatus} />
            <nav className="nav">
              <div className="nav-label">{t("nav.section")}</div>
              {NAV.filter(({ view: v }) => {
                const owner = moduleForView(v);
                return owner === null || moduleOn(owner);
              }).map(
                ({ view: v, icon: Icon }) => (
                  <button
                    key={v}
                    className={`nav-item ${view === v ? "active" : ""}`}
                    onClick={() => setView(v)}
                  >
                    <Icon size={17} className="nav-icon" />
                    {t(`nav.${v}`)}
                    {v === "tasks" && <NavBadge count={blocked} title={t("status.blocked")} />}
                    {v === "inbox" && (
                      <NavBadge
                        count={inboxUnseen}
                        title={t("notify.unreadDeliveries")}
                        tone="event"
                      />
                    )}
                    {v === "terminal" && wsRoot !== null && runningRoots.has(wsRoot) && (
                      <span
                        className="nav-dot"
                        title={t("term.runningMark")}
                        aria-label={t("term.runningMark")}
                      />
                    )}
                  </button>
                ),
              )}
            </nav>
          </div>
        )}
        </div>

        {agentLive && (
          <div className="sidebar-foot">
            <span className="agent-live">
              <span className="pulse" aria-hidden="true">
                <span className="ring" />
                <span className="core" />
              </span>
              {t("app.agentLive")}
            </span>
          </div>
        )}
        {/* A shortcut-only feature may as well not exist — nothing on
            screen ever mentions it. This button is both the entry point and
            the documentation (in-app help proper is B9's job; all this does
            is make Ctrl+K visible). */}
        <div className="sidebar-foot">
          <button className="cmdk-open" onClick={() => setPaletteOpen(true)}>
            <IconSearch size={13} className="nav-icon" />
            <span className="cmdk-open-label">{t("cmdk.label")}</span>
            <kbd>{SHORTCUT_HINT.palette}</kbd>
          </button>
        </div>
        <div className="sidebar-foot">
          <span className="muted">v{status.appVersion}</span>
        </div>
      </aside>

      <main className="content">
        {loadError !== null && (
          <div className="alert alert-error">
            {t("app.refreshFailed")} {loadError}
          </div>
        )}
        {actionError !== null && (
          <div className="alert alert-error">
            {actionError}
            <button className="btn btn-ghost" onClick={() => setActionError(null)}>
              {t("common.close")}
            </button>
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
              runningRoots={runningRoots}
            />
          )}
          {view === "teams" && <Teams refreshKey={refreshKey} pushToast={pushToast} />}
          {view === "agents" && (
            <AgentSessions
              sessions={termSessions}
              overview={recent}
              onOpen={(root) => void openTerminalOf(root)}
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
            <>
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
                />
              )}
              {view === "terminal" && (
                <TerminalView
                  // Remount on a workspace change so per-root state (active tab,
                  // D69 path B) never carries across roots (adversarial-review).
                  key={status.workspace?.root ?? ""}
                  root={status.workspace?.root ?? ""}
                  onSessionsChanged={reloadTerminals}
                />
              )}
              {view === "projectSettings" && (
                <ProjectSettings
                  status={status}
                  onStatusChange={applyStatus}
                  modules={modules}
                  onModulesChange={setModules}
                  onGoToAppSettings={() => setView("settings")}
                />
              )}
            </>
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

      <ToastStack toasts={toasts} onDismiss={dismiss} />

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
