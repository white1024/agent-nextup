import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import { useFlash, useGuardedMutation } from "../../hooks";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import FlashBar from "../../components/FlashBar";
import Modal, { closeIntoRow } from "../../components/Modal";
import { centreOf, fx, lightNav, motionOff, navItem } from "../../lib/fx";
import { EASE_OUT, fadeRowsOut, rowTops, slideRows } from "../../lib/listMotion";
import InfoTip from "../../components/InfoTip";
import type { CSSProperties } from "react";
import type { AgentInfo, CustomAgent } from "../../types";

function blankAgent(): CustomAgent {
  return { id: "", title: "", command: "", args: [], env: {} };
}

/** env map → editable `.env`-style text (one KEY=value per line). */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** `.env`-style text → env map. Blank lines and lines without `=` are
 *  dropped; core validates names and rejects the rest. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "") continue;
    env[key] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** App-level agent CLI catalog (D50): the launch menu of the embedded
 *  terminal. Presets are read-only with a live PATH probe; custom entries
 *  (name + command + args) are editable. Core owns validation and the
 *  preset-id rejection. */
export default function AgentCatalogManager() {
  const { t } = useTranslation();
  // `null` until the first read resolves (D65, invariant 10). Not a formality
  // here: `list_agents` runs a PATH probe per entry, so on Windows this is one
  // of the slower reads in the app — and the built-ins are pushed
  // unconditionally, so a resolved list is never empty. An
  // `agents.length === 0` empty state can therefore only ever mean "not read
  // yet" or "the read failed", never "you have no agents".
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [draft, setDraft] = useState<CustomAgent | null>(null);
  // Raw editing buffer for the env field so partial lines (mid-typing a
  // KEY before its `=`) survive; parsed to a map only on save.
  const [envText, setEnvText] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy: saving, run: runSave } = useGuardedMutation(setError);
  const { flash, showFlash } = useFlash(3000);
  const listRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .agentCatalogList()
      .then(setAgents)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  function openEditor(agent: AgentInfo | null) {
    setError(null);
    setConfirmingDelete(null);
    if (agent === null) {
      setDraft(blankAgent());
      setEnvText("");
      setCreating(true);
    } else {
      setDraft({
        id: agent.id,
        title: agent.title,
        command: agent.command,
        args: agent.args,
        env: agent.env,
      });
      setEnvText(envToText(agent.env));
      setCreating(false);
    }
  }

  /**
   * C195 (my-design review F1, F7): the dialog closes into the CLI's row (new
   * or edited), which stays hidden until the frame lands; the row then probes
   * PATH once more (C190 again), a light flies from its lamp to the sidebar's
   * agent overview — where the launcher now offers it — that entry lights,
   * and "Saved" drops in. Reduced motion: the dialog closes and the result
   * line shows.
   */
  function saveDraft() {
    if (!draft) return;
    const id = draft.id.trim();
    return runSave(async () => {
      setError(null);
      const next = await api.agentCatalogSave({
        ...draft,
        id,
        title: draft.title.trim(),
        command: draft.command.trim(),
        args: draft.args.map((a) => a.trim()).filter(Boolean),
        env: parseEnv(envText),
      });
      const land = closeIntoRow(formRef.current);
      flushSync(() => {
        setAgents(next);
        setDraft(null);
      });
      const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;
      land(row);
      if (motionOff() || row === null) {
        showFlash(t("agents.saved"));
        return;
      }
      window.setTimeout(() => {
        // C190 again, now that the row is in place.
        for (const a of row.getAnimations({ subtree: true })) {
          a.currentTime = 0;
          a.play();
        }
      }, 420);
      window.setTimeout(() => {
        const entry = navItem("agents");
        fx.beam(centreOf(row.querySelector(".cli-lamp")), centreOf(entry?.querySelector(".nav-icon") ?? entry), {
          width: 2.2,
          dur: 560,
        });
        window.setTimeout(() => {
          lightNav(entry);
          showFlash(t("agents.saved"));
        }, 520);
      }, 640);
    });
  }

  /** C195, deleting: the row fades where it stands and the rows below close up. */
  async function remove(id: string) {
    setError(null);
    try {
      const next = await api.agentCatalogDelete(id);
      setConfirmingDelete(null);
      const list = listRef.current;
      const before = rowTops(list);
      await fadeRowsOut([list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null]);
      flushSync(() => setAgents(next));
      slideRows(list, before, { duration: 340, easing: EASE_OUT });
      showFlash(t("agents.deleted"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const canSave =
    draft !== null &&
    draft.id.trim() !== "" &&
    draft.title.trim() !== "" &&
    draft.command.trim() !== "";

  // The row hands over an id; the dialog has to name what is being deleted.
  const deleteTarget = (agents ?? []).find((a) => a.id === confirmingDelete) ?? null;

  return (
    <section className="panel settings-sec">
      <div className="panel-head">
        <h2 className="panel-title">{t("agents.heading")}</h2>
        <InfoTip label={t("common.moreInfo")}>{t("agents.hint")}</InfoTip>
        <span className="spacer" />
        {/* Hidden, not removed, while its dialog is open: the list below
            must not jump when the button comes and goes. */}
        <button
          className={`btn btn-small${draft === null ? "" : " is-away"}`}
          aria-hidden={draft !== null}
          tabIndex={draft === null ? undefined : -1}
          onClick={() => openEditor(null)}
        >
          {t("agents.add")}
        </button>
      </div>
      {/* Load errors show here; save and delete errors show inside their own
          dialog so the user sees them where the attempt was made. */}
      {error && draft === null && confirmingDelete === null && (
        <div className="alert alert-error">{error}</div>
      )}
      <FlashBar message={flash} />
      {agents !== null && agents.length === 0 && (
        <EmptyState title={t("agents.empty")} hint={t("agents.emptyHint")} />
      )}
      {/* Reading the catalog probes PATH once per entry — one of the slower
          reads in the app — so it earns a skeleton (invariant 10(c)): four
          empty rows, lamps hollow, a light sweeping where the command will
          be (C190, the reading-in-progress loop). */}
      {agents === null && error === null && (
        <div className="cli-list" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          {[38, 30, 34, 22].map((w, i) => (
            <div className="cli-row cli-row--skel" key={i} style={{ "--i": i } as CSSProperties}>
              <span className="cli-lamp" aria-hidden="true" />
              <div className="cli-main">
                <span className="cli-bar" style={{ width: `${w}%` }} />
                <span className="cli-bar cli-bar--sm cli-probe" style={{ width: `${w + 24}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="cli-list" ref={listRef}>
        {(agents ?? []).map((agent, i) => (
          // C190: each row rises in, a light sweeps its command (the PATH
          // probe made visible), then the lamp of a CLI that was found lights.
          // Rows mount once per arrival, so this plays on the first read and
          // for a newly saved entry — never on a re-render.
          <div className="cli-row" key={agent.id} data-row={agent.id} style={{ "--i": i } as CSSProperties}>
            <span
              className={`cli-lamp${agent.installed ? " on" : ""}`}
              role="img"
              aria-label={agent.installed ? t("agents.found") : t("agents.notInstalled")}
            />
            <div className="tpl-row-main cli-main">
              <span className="tpl-row-name">
                {agent.title}
                <span className="chip template-badge">
                  {agent.builtin ? t("agents.builtIn") : t("agents.custom")}
                </span>
                {!agent.installed && (
                  <span className="chip template-badge cli-miss">{t("agents.notInstalled")}</span>
                )}
              </span>
              <span className="tpl-row-meta muted cli-cmd cli-probe">
                {[agent.command, ...agent.args].join(" ")}
              </span>
              {Object.keys(agent.env).length > 0 && (
                // Names only — a value may be an API key; never render it here.
                <span className="tpl-row-meta muted">
                  env: {Object.keys(agent.env).join(", ")}
                </span>
              )}
            </div>
            {!agent.builtin && (
              <span className="cli-acts">
                <button className="btn btn-ghost btn-small" onClick={() => openEditor(agent)}>
                  {t("agents.edit")}
                </button>
                <button
                  className="btn btn-ghost btn-small danger-trigger"
                  onClick={() => {
                    setError(null);
                    setConfirmingDelete(agent.id);
                  }}
                >
                  {t("common.delete")}
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      {deleteTarget && (
        <ConfirmDanger
          heading={t("agents.deleteHeading")}
          body={t("agents.deleteBody", { name: deleteTarget.title })}
          confirmLabel={t("common.delete")}
          error={error}
          onConfirm={() => void remove(deleteTarget.id)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
      {draft && (
        <Modal
          label={
            creating ? t("agents.editorCreate") : t("agents.editorEdit", { name: draft.title })
          }
          onClose={() => setDraft(null)}
        >
        <div className="form" ref={formRef}>
          <h2 className="form-heading">
            {creating ? t("agents.editorCreate") : t("agents.editorEdit", { name: draft.title })}
          </h2>
          {/* C194: a refused save drops its reason in from above (keyed, so a
              second refusal with other words drops in again). */}
          {error && (
            <div className="alert alert-error err-drop" key={error}>
              {error}
            </div>
          )}
          <div className="tpl-grid">
            <label className="field">
              <span>{t("agents.id")}</span>
              <input
                value={draft.id}
                disabled={!creating}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="my-cli"
              />
              {creating && <span className="muted tpl-subhint">{t("agents.idHint")}</span>}
            </label>
            <label className="field">
              <span>{t("agents.name")}</span>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>{t("agents.command")}</span>
            <input
              className="tpl-mono"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="aider"
            />
            <span className="muted tpl-subhint">{t("agents.commandHint")}</span>
          </label>
          <label className="field">
            <span>{t("agents.args")}</span>
            <textarea
              className="tpl-mono"
              rows={2}
              value={draft.args.join("\n")}
              onChange={(e) => setDraft({ ...draft, args: e.target.value.split("\n") })}
            />
          </label>
          <label className="field">
            <span>{t("agents.env")}</span>
            <textarea
              className="tpl-mono"
              rows={3}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"ANTHROPIC_BASE_URL=http://localhost:8080\nANTHROPIC_API_KEY=local"}
            />
            <span className="muted tpl-subhint">{t("agents.envHint")}</span>
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn btn-primary"
              disabled={!canSave || saving}
              onClick={() => void saveDraft()}
            >
              {t("agents.save")}
            </button>
          </div>
        </div>
        </Modal>
      )}
    </section>
  );
}
