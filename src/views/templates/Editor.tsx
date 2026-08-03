import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import { IconArrowRight, IconPlus, IconX } from "../../components/icons";
import type { Gate, TemplateSummary, WorkflowPhase, WorkflowTemplate } from "../../types";

/** How the editor was entered: decides id mutability and read-only-ness. */
export type EditorMode = "create" | "edit" | "view";

const GATE_KINDS: Gate["kind"][] = [
  "min_tasks",
  "min_decisions",
  "all_tasks_done",
  "no_blocked_tasks",
  "artifact_exists",
  "manual_confirm",
  "doctor_clean",
];

/** Mirror of core's `validate_custom_id` — inline feedback only, core still owns the rule. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function defaultGate(kind: Gate["kind"]): Gate {
  switch (kind) {
    case "min_tasks":
      return { kind, count: 1 };
    case "min_decisions":
      return { kind, count: 1 };
    case "artifact_exists":
      return { kind, path: "" };
    case "manual_confirm":
      return { kind, prompt: "" };
    default:
      return { kind } as Gate;
  }
}

/** Template id derived from the name (D44 folder-name convention): ascii
 *  slug when the name yields one, unique against the catalog either way.
 *  CJK-only names fall back to a neutral base — the field stays editable. */
function deriveTemplateId(name: string, taken: Set<string>): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
  const base = slug === "" ? "custom" : slug;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Smallest phase-N not already used — reorders never renumber. */
function nextPhaseId(phases: WorkflowPhase[]): string {
  const used = new Set(phases.map((p) => p.id));
  for (let n = 1; ; n++) {
    const candidate = `phase-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Trim fields and drop empty AI-instruction lines; core validates the rest. */
function normalized(t: WorkflowTemplate): WorkflowTemplate {
  return {
    ...t,
    id: t.id.trim(),
    name: t.name.trim(),
    description: t.description.trim(),
    domainHint: t.domainHint.trim(),
    phases: t.phases.map((p) => ({
      ...p,
      id: p.id.trim(),
      title: p.title.trim(),
      description: p.description.trim(),
      aiInstructions: p.aiInstructions.map((l) => l.trim()).filter(Boolean),
    })),
  };
}

interface Props {
  mode: EditorMode;
  template: WorkflowTemplate;
  /** Every catalog id (built-in + custom) — id derivation and collision checks. */
  existingIds: string[];
  /** Save succeeded; the fresh summaries ride along so the list needs no refetch. */
  onSaved: (list: TemplateSummary[]) => void;
  onClose: () => void;
  /** View mode's "New from this" — parent restarts the editor in create mode. */
  onCopy: (base: WorkflowTemplate) => void;
}

/**
 * Full-page master-detail template editor (D51): basics on top, phase rail on
 * the left, the selected phase's detail on the right. Built-ins render the
 * same page read-only.
 */
export default function TemplateEditor({
  mode,
  template,
  existingIds,
  onSaved,
  onClose,
  onCopy,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<WorkflowTemplate>(template);
  const [selected, setSelected] = useState(0);
  const [idTouched, setIdTouched] = useState(false);
  const [pickingGate, setPickingGate] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialJson = useRef(JSON.stringify(template));

  const readOnly = mode === "view";
  const taken = useMemo(() => new Set(existingIds), [existingIds]);
  const dirty = JSON.stringify(draft) !== initialJson.current;

  const patch = (changes: Partial<WorkflowTemplate>) => setDraft({ ...draft, ...changes });
  const patchPhase = (i: number, changes: Partial<WorkflowPhase>) =>
    patch({ phases: draft.phases.map((p, pi) => (pi === i ? { ...p, ...changes } : p)) });
  const patchGate = (i: number, gi: number, gate: Gate) =>
    patchPhase(i, {
      exitGates: draft.phases[i].exitGates.map((g, ggi) => (ggi === gi ? gate : g)),
    });

  function setName(name: string) {
    // Until the id field is touched the id tracks the name (create mode only).
    if (mode === "create" && !idTouched) {
      patch({ name, id: name.trim() === "" ? "" : deriveTemplateId(name, taken) });
    } else {
      patch({ name });
    }
  }

  const movePhase = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= draft.phases.length) return;
    const phases = [...draft.phases];
    [phases[i], phases[j]] = [phases[j], phases[i]];
    patch({ phases });
    if (selected === i) setSelected(j);
    else if (selected === j) setSelected(i);
  };

  const removePhase = (i: number) => {
    if (draft.phases.length === 1) return;
    patch({ phases: draft.phases.filter((_, pi) => pi !== i) });
    setSelected((cur) => (cur > i || cur === draft.phases.length - 1 ? cur - 1 : cur));
  };

  const addPhase = () => {
    const phase: WorkflowPhase = {
      id: nextPhaseId(draft.phases),
      title: "",
      description: "",
      aiInstructions: [],
      exitGates: [],
    };
    patch({ phases: [...draft.phases, phase] });
    setSelected(draft.phases.length);
    setPickingGate(false);
  };

  const trimmedId = draft.id.trim();
  const idInvalid = trimmedId !== "" && !ID_RE.test(trimmedId);
  const idTaken = mode === "create" && taken.has(trimmedId);
  const phaseIdCounts = new Map<string, number>();
  for (const p of draft.phases) {
    const id = p.id.trim();
    phaseIdCounts.set(id, (phaseIdCounts.get(id) ?? 0) + 1);
  }
  const canSave =
    trimmedId !== "" &&
    !idInvalid &&
    !idTaken &&
    draft.name.trim() !== "" &&
    draft.phases.length > 0 &&
    draft.phases.every(
      (p) => p.id.trim() !== "" && p.title.trim() !== "" && phaseIdCounts.get(p.id.trim()) === 1,
    );

  // Deliberately *not* on `useGuardedMutation`, and not an oversight: there is
  // no `finally` here, because on success `onSaved` unmounts this editor and
  // leaving `saving` true is what keeps the button from flashing back to
  // clickable on the way out. The hook always clears its flag. Nothing is lost
  // by staying: `saveCustomTemplate` upserts by id, so a repeated call is
  // idempotent and needs no gate.
  async function save() {
    setError(null);
    setSaving(true);
    try {
      onSaved(await api.saveCustomTemplate(normalized(draft)));
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  function requestClose() {
    if (!readOnly && dirty) setConfirmDiscard(true);
    else onClose();
  }

  const phase = draft.phases[selected] ?? draft.phases[0];
  const phaseIndex = draft.phases[selected] !== undefined ? selected : 0;

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>
            {mode === "create"
              ? t("tpl.editorCreate")
              : mode === "edit"
                ? t("tpl.editorEdit")
                : t("tpl.editorView")}
            {draft.name.trim() !== "" && <span className="vh-name">{draft.name}</span>}
            {readOnly && <span className="chip template-badge">{t("tpl.builtIn")}</span>}
          </h1>
          <p className="view-sub">{readOnly ? t("tpl.viewHint") : t("tpl.editorHint")}</p>
        </div>
        <div className="header-actions">
          {readOnly ? (
            <>
              <button className="btn" onClick={onClose}>
                {t("tpl.back")}
              </button>
              <button className="btn btn-primary" onClick={() => onCopy(draft)}>
                {t("tpl.newFromThis")}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={requestClose}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary" disabled={!canSave || saving} onClick={() => void save()}>
                {t("tpl.save")}
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="panel">
        <div className="tpl-meta-grid">
          <label className="field">
            <span>{t("tpl.name")}</span>
            <input
              value={draft.name}
              disabled={readOnly}
              autoFocus={mode === "create"}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("tpl.id")}</span>
            <input
              className="tpl-mono"
              value={draft.id}
              disabled={mode !== "create"}
              onChange={(e) => {
                setIdTouched(true);
                patch({ id: e.target.value });
              }}
              placeholder="my-flow-v1"
            />
            {mode === "create" && (
              <span className={`tpl-subhint ${idInvalid || idTaken ? "tpl-field-error" : "muted"}`}>
                {idInvalid
                  ? t("tpl.idInvalid")
                  : idTaken
                    ? t("tpl.idTaken")
                    : t("tpl.idHint")}
              </span>
            )}
          </label>
          <label className="field tpl-meta-desc">
            <span>{t("tpl.desc")}</span>
            <input
              value={draft.description}
              disabled={readOnly}
              placeholder={readOnly ? undefined : t("tpl.descPlaceholder")}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
        </div>
      </section>

      <div className="tpl-body">
        <aside className="tpl-rail">
          <div className="tpl-rail-head">{t("tpl.phases")}</div>
          {draft.phases.map((p, i) => (
            <div key={i} className={`tpl-rail-item ${i === phaseIndex ? "active" : ""}`}>
              <button className="tpl-rail-select" onClick={() => setSelected(i)}>
                <span className="tpl-phase-num">{i + 1}</span>
                <span className="tpl-rail-title">
                  {p.title.trim() !== "" ? p.title : t("tpl.untitledPhase")}
                </span>
                {p.exitGates.length > 0 && (
                  <span className="tpl-rail-gates">
                    {t("tpl.gateCountShort", { n: p.exitGates.length })}
                  </span>
                )}
              </button>
              {!readOnly && (
                <span className="tpl-rail-actions">
                  <button
                    className="btn btn-ghost btn-icon"
                    disabled={i === 0}
                    title={t("tpl.moveUp")}
                    aria-label={t("tpl.moveUp")}
                    onClick={() => movePhase(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    disabled={i === draft.phases.length - 1}
                    title={t("tpl.moveDown")}
                    aria-label={t("tpl.moveDown")}
                    onClick={() => movePhase(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    disabled={draft.phases.length === 1}
                    title={t("tpl.removePhase")}
                    aria-label={t("tpl.removePhase")}
                    onClick={() => removePhase(i)}
                  >
                    <IconX size={12} />
                  </button>
                </span>
              )}
            </div>
          ))}
          {!readOnly && (
            <button className="btn btn-ghost btn-small tpl-rail-add" onClick={addPhase}>
              <IconPlus size={13} /> {t("tpl.addPhase")}
            </button>
          )}
        </aside>

        <section className="panel tpl-detail">
          <div className="tpl-detail-grid">
            <label className="field">
              <span>{t("tpl.phaseTitle")}</span>
              <input
                value={phase.title}
                disabled={readOnly}
                onChange={(e) => patchPhase(phaseIndex, { title: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t("tpl.phaseId")}</span>
              <input
                className="tpl-mono"
                value={phase.id}
                disabled={readOnly}
                onChange={(e) => patchPhase(phaseIndex, { id: e.target.value })}
              />
              {!readOnly && (
                <span
                  className={`tpl-subhint ${
                    phase.id.trim() !== "" && (phaseIdCounts.get(phase.id.trim()) ?? 0) > 1
                      ? "tpl-field-error"
                      : "muted"
                  }`}
                >
                  {phase.id.trim() !== "" && (phaseIdCounts.get(phase.id.trim()) ?? 0) > 1
                    ? t("tpl.phaseIdDup")
                    : t("tpl.phaseIdHint")}
                </span>
              )}
            </label>
          </div>
          <label className="field">
            <span>{t("tpl.phaseDesc")}</span>
            <input
              value={phase.description}
              disabled={readOnly}
              onChange={(e) => patchPhase(phaseIndex, { description: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("tpl.aiInstructions")}</span>
            <textarea
              rows={4}
              value={phase.aiInstructions.join("\n")}
              disabled={readOnly}
              placeholder={readOnly ? undefined : t("tpl.aiInstructionsHint")}
              onChange={(e) => patchPhase(phaseIndex, { aiInstructions: e.target.value.split("\n") })}
            />
          </label>

          <div className="tpl-gates">
            <div className="tpl-gates-head">
              <span className="tpl-gates-label">{t("tpl.gates")}</span>
              <span className="muted tpl-subhint">{t("tpl.gatesHint")}</span>
            </div>
            {phase.exitGates.length === 0 && !pickingGate && (
              <EmptyState className="tpl-gates-empty" title={t("tpl.gatesEmpty")} />
            )}
            {phase.exitGates.map((g, gi) => (
              <div className="gate-card" key={gi}>
                <div className="gate-card-head">
                  <span className="gate-card-name">{t(`tpl.gateKinds.${g.kind}`)}</span>
                  {!readOnly && (
                    <button
                      className="btn btn-ghost btn-icon"
                      title={t("tpl.removeGate")}
                      aria-label={t("tpl.removeGate")}
                      onClick={() =>
                        patchPhase(phaseIndex, {
                          exitGates: phase.exitGates.filter((_, ggi) => ggi !== gi),
                        })
                      }
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </div>
                <div className="gate-card-desc">{t(`tpl.gateDesc.${g.kind}`)}</div>
                {(g.kind === "min_tasks" || g.kind === "min_decisions") && (
                  <label className="field gate-card-param">
                    <span>{t("tpl.gateCount")}</span>
                    <input
                      type="number"
                      min={1}
                      className="tpl-mini"
                      value={g.count}
                      disabled={readOnly}
                      onChange={(e) =>
                        patchGate(phaseIndex, gi, {
                          ...g,
                          count: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                        })
                      }
                    />
                  </label>
                )}
                {g.kind === "artifact_exists" && (
                  <label className="field gate-card-param">
                    <span>{t("tpl.gatePath")}</span>
                    <input
                      className="tpl-mono"
                      value={g.path}
                      disabled={readOnly}
                      placeholder="artifacts/report.md"
                      onChange={(e) => patchGate(phaseIndex, gi, { ...g, path: e.target.value })}
                    />
                  </label>
                )}
                {g.kind === "manual_confirm" && (
                  <label className="field gate-card-param">
                    <span>{t("tpl.gatePrompt")}</span>
                    <input
                      value={g.prompt}
                      disabled={readOnly}
                      placeholder={readOnly ? undefined : t("tpl.gatePromptPlaceholder")}
                      onChange={(e) => patchGate(phaseIndex, gi, { ...g, prompt: e.target.value })}
                    />
                  </label>
                )}
              </div>
            ))}

            {!readOnly && !pickingGate && (
              <div>
                <button className="btn btn-ghost btn-small" onClick={() => setPickingGate(true)}>
                  <IconPlus size={13} /> {t("tpl.addGate")}
                </button>
              </div>
            )}
            {!readOnly && pickingGate && (
              <div className="gate-pick">
                <div className="tpl-gates-head">
                  <span className="tpl-gates-label">{t("tpl.gatePickTitle")}</span>
                  <button className="btn btn-ghost btn-small" onClick={() => setPickingGate(false)}>
                    {t("common.cancel")}
                  </button>
                </div>
                <div className="gate-pick-grid">
                  {GATE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      className="gate-pick-card"
                      onClick={() => {
                        patchPhase(phaseIndex, {
                          exitGates: [...phase.exitGates, defaultGate(kind)],
                        });
                        setPickingGate(false);
                      }}
                    >
                      <span className="gate-card-name">
                        {t(`tpl.gateKinds.${kind}`)} <IconArrowRight size={12} />
                      </span>
                      <span className="gate-card-desc">{t(`tpl.gateDesc.${kind}`)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {confirmDiscard && (
        <ConfirmDanger
          heading={t("tpl.discardHeading")}
          body={t("tpl.discardBody")}
          confirmLabel={t("tpl.discardAction")}
          cancelLabel={t("tpl.keepEditing")}
          onConfirm={onClose}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
