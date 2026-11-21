import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../../api";
import Modal from "../../components/Modal";
import Segmented from "../../components/Segmented";
import { IconFolder, IconX } from "../../components/icons";
import { useGuardedMutation } from "../../hooks";
import { relativeTime } from "../../lib/time";
import type { ImportPreview, ImportRow, RelinkReport, Team } from "../../types";
import { defaultTake, mergeRelink, newerSide, scopeReport, takeList } from "./transfer";

/** The name the save dialog suggests (D173 ②); mirrors `DEFAULT_FILE_NAME` in `team_transfer.rs`. */
const FILE_NAME = "nextup-teams.json";

/** "Look in a folder…": the folder the person's projects sit in, or null when cancelled. */
export async function pickSearchFolder(): Promise<string | null> {
  const dir = await open({ directory: true });
  return typeof dir === "string" ? dir : null;
}

/** The team file to import, or null when cancelled. */
export async function pickTeamFile(kind: string): Promise<string | null> {
  const file = await open({ multiple: false, filters: [{ name: kind, extensions: ["json"] }] });
  return typeof file === "string" ? file : null;
}

/**
 * What a re-link found (D173 ①), said out loud — and, while anyone is still
 * missing, the way to look further: a folder the person picks, searched one
 * level down. Neutral surface, not amber: a folder that is not on this
 * machine yet is a fact about the machine, not a warning about their data.
 */
export function RelinkLine({
  report,
  busy,
  onSearch,
  onClose,
}: {
  report: RelinkReport;
  busy: boolean;
  onSearch: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const found = report.relinked.length;
  const left = report.missing.length;
  return (
    <div className="alert alert-info tx-relink" role="status">
      <div className="tx-relink-text">
        <p>
          {found > 0
            ? t("teams.relinkFound", { n: found, names: report.relinked.map((r) => r.name).join(t("teams.listSep")) })
            : left === 0
              ? t("teams.relinkNone")
              : t("teams.relinkNoneFound")}
        </p>
        {left > 0 && (
          <p>{t("teams.relinkMissing", { n: left, names: report.missing.map((m) => m.name).join(t("teams.listSep")) })}</p>
        )}
      </div>
      {left > 0 && (
        <button className="btn btn-small" disabled={busy} onClick={onSearch}>
          <IconFolder size={13} /> {t("teams.relinkFolder")}
        </button>
      )}
      {onClose && (
        <button
          className="btn btn-ghost btn-icon"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  );
}

/** Pick teams and write them to a file the person carries (D173 ②). */
export function ExportDialog({
  teams,
  onClose,
  onDone,
}: {
  teams: Team[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(teams.map((x) => x.id)));
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useGuardedMutation(setError);

  // The save dialog is awaited outside the guard, as the backup export does:
  // cancelling it must leave the dialog as it was, not flash a busy state.
  async function exportNow() {
    setError(null);
    let dest: string | null;
    try {
      dest = await save({ defaultPath: FILE_NAME, filters: [{ name: t("teams.fileKind"), extensions: ["json"] }] });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (typeof dest !== "string") return;
    const target = dest;
    await run(async () => {
      const ids = teams.filter((x) => picked.has(x.id)).map((x) => x.id);
      const n = await api.teamExport(ids, target);
      onDone(t("teams.exported", { n, file: target }));
    });
  }

  return (
    <Modal label={t("teams.exportTitle")} narrow onClose={onClose}>
      <div className="form">
        <h2 className="form-heading">{t("teams.exportTitle")}</h2>
        <p className="muted">{t("teams.exportHint")}</p>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="dlg-cands">
          {teams.map((team) => (
            <label key={team.id} className="dlg-cand">
              <span>
                <b>{team.name}</b>
                <small>
                  {t("teams.cardMembers", { n: team.members.length })} · {t("teams.cardEdges", { n: team.edges.length })}
                </small>
              </span>
              <input
                type="checkbox"
                checked={picked.has(team.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(team.id);
                  else next.delete(team.id);
                  setPicked(next);
                }}
              />
            </label>
          ))}
        </div>
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || picked.size === 0}
            onClick={() => void exportNow()}
          >
            {t("teams.exportAction")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Import a team file (D173 ②): one row per team in it, each pre-answered
 * (added / nothing to do / the newer side), then the result with the re-link
 * that ran after it. No merge — where both sides differ, the person picks one.
 */
export function ImportDialog({
  file,
  preview,
  onClose,
  onTeams,
}: {
  file: string;
  preview: ImportPreview;
  onClose: () => void;
  onTeams: (teams: Team[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(preview.teams.filter(defaultTake).map((r) => r.id)),
  );
  const [result, setResult] = useState<{ added: number; replaced: number; report: RelinkReport; teams: Team[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useGuardedMutation(setError);
  const take = takeList(preview.teams, picked);
  const when = (at: string) => relativeTime(at, i18n.language);

  function pick(id: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  }

  function apply() {
    return run(async () => {
      setError(null);
      const done = await api.teamImportApply(file, take);
      onTeams(done.teams);
      const taken = done.teams.filter((x) => take.includes(x.id));
      setResult({
        added: done.outcome.added,
        replaced: done.outcome.replaced,
        report: scopeReport(done.outcome.relink, taken),
        teams: taken,
      });
    });
  }

  async function searchFolder() {
    if (result === null) return;
    const dir = await pickSearchFolder();
    if (dir === null) return;
    const before = result;
    await run(async () => {
      const done = await api.teamRelink(dir);
      onTeams(done.teams);
      setResult({ ...before, report: mergeRelink(before.report, scopeReport(done.report, before.teams)) });
    });
  }

  function meta(row: ImportRow) {
    const parts = [t("teams.cardMembers", { n: row.members }), t("teams.cardEdges", { n: row.edges })];
    if (row.prime !== null) parts.push(t("teams.primeChip", { name: row.prime }));
    return parts.join(" · ");
  }

  return (
    <Modal label={t("teams.importTitle")} onClose={onClose}>
      <div className="form">
        <h2 className="form-heading">{t("teams.importTitle")}</h2>
        {error && <div className="alert alert-error">{error}</div>}
        {result !== null ? (
          <>
            <p>{t("teams.imported", { added: result.added, replaced: result.replaced })}</p>
            <RelinkLine report={result.report} busy={busy} onSearch={() => void searchFolder()} />
            <div className="form-actions">
              <button className="btn btn-primary" onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              {t("teams.importFrom", { at: when(preview.exportedAt), version: preview.appVersion || "?" })}
            </p>
            <div className="dlg-cands tx-rows">
              {preview.teams.map((row) => {
                if (row.status === "new") {
                  return (
                    <label key={row.id} className="dlg-cand">
                      <span>
                        <b>{row.name}</b>
                        <span className="chip">{t("teams.importNew")}</span>
                        <small>{meta(row)}</small>
                      </span>
                      <input
                        type="checkbox"
                        aria-label={t("teams.importAdd", { name: row.name })}
                        checked={picked.has(row.id)}
                        onChange={(e) => pick(row.id, e.target.checked)}
                      />
                    </label>
                  );
                }
                if (row.status === "same") {
                  return (
                    <div key={row.id} className="dlg-cand tx-row--same">
                      <span>
                        <b>{row.name}</b>
                        <span className="chip">{t("teams.importSame")}</span>
                        <small>{meta(row)}</small>
                      </span>
                    </div>
                  );
                }
                const newer = newerSide(row);
                return (
                  <div key={row.id} className="dlg-cand tx-row">
                    <span>
                      <b>{row.name}</b>
                      <span className="chip">{t("teams.importDiffers")}</span>
                      {row.localName !== null && row.localName !== row.name && (
                        <small>{t("teams.importLocalName", { name: row.localName })}</small>
                      )}
                      <small>{meta(row)}</small>
                      <small>
                        {t("teams.importStamps", {
                          file: when(row.fileUpdatedAt),
                          local: when(row.localUpdatedAt ?? ""),
                        })}
                        {newer !== "tie" &&
                          ` · ${t(newer === "file" ? "teams.importFileNewer" : "teams.importLocalNewer")}`}
                      </small>
                    </span>
                    <Segmented
                      label={t("teams.importSide", { name: row.name })}
                      value={picked.has(row.id) ? "file" : "local"}
                      options={[
                        { value: "file", label: t("teams.importTakeFile") },
                        { value: "local", label: t("teams.importKeepLocal") },
                      ]}
                      onChange={(side) => pick(row.id, side === "file")}
                    />
                  </div>
                );
              })}
            </div>
            <p className="dlg-hint">{t("teams.importHint")}</p>
            <div className="form-actions">
              <button className="btn" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary" disabled={busy || take.length === 0} onClick={() => void apply()}>
                {take.length === 0 ? t("teams.importNothing") : t("teams.importApply", { n: take.length })}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
