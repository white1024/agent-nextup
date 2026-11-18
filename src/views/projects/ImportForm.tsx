import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { IconLock } from "../../components/icons";
import { useGuardedMutation } from "../../hooks";
import { baseName } from "../../lib/format";
import type { SystemStatus } from "../../types";
import ProjectCard from "./ProjectCard";
import WizardFrame from "./WizardFrame";
import { unsealCard } from "./motion";
import { NO_TASKS } from "./InitWizard";

/** The passphrase floor the backend enforces; the counter counts towards it. */
const PASSPHRASE_MIN = 8;

/**
 * Import a backup (spec 20 section 8). Until it is decrypted nothing is known
 * about what is inside — so the right column is an empty card under a seal,
 * not a guess. On success the seal opens (C40) and the card grows into the
 * restored project's dashboard.
 */
export default function ImportForm({
  error,
  onCancel,
  onLoaded,
  onError,
}: {
  error: string | null;
  onCancel: () => void;
  onLoaded: (status: SystemStatus, card: HTMLElement | null) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const [archive, setArchive] = useState("");
  const [dest, setDest] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const { busy, run } = useGuardedMutation(onError);
  const preview = useRef<HTMLUListElement>(null);

  async function chooseArchive() {
    const file = await open({
      filters: [{ name: "Agent NextUp backup", extensions: ["zip"] }],
    });
    if (typeof file === "string") setArchive(file);
  }

  async function chooseDest() {
    const dir = await open({ directory: true });
    if (typeof dir === "string") setDest(dir);
  }

  function submit() {
    return run(async () => {
      onError(null);
      const status = await api.importBackup(archive, dest, passphrase);
      const card = preview.current?.querySelector<HTMLElement>(".pcard") ?? null;
      await unsealCard(card);
      onLoaded(status, card);
    });
  }

  const enough = passphrase.length >= PASSPHRASE_MIN;
  const ready = archive !== "" && dest !== "" && enough && !busy;

  return (
    <WizardFrame
      title={t("import.heading")}
      error={error}
      short
      side={
        <>
          <p className="wz-side-h">{t("import.side")}</p>
          <ul className="wz-preview" ref={preview}>
            <ProjectCard
              preview
              className="sealed"
              data={{
                root: dest === "" ? "\u2026" : dest,
                name: "",
                domain: "",
                exists: true,
                taskCounts: NO_TASKS,
                workflowCompleted: false,
              }}
              overlay={
                <div className="wz-seal">
                  <IconLock size={22} className="wz-lock" />
                  <span>{t("import.sealed")}</span>
                </div>
              }
            />
          </ul>
          {archive !== "" && <p className="wz-file">{baseName(archive)}</p>}
        </>
      }
      foot={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
            {busy ? t("import.running") : t("import.run")}
          </button>
        </>
      }
    >
      <div className="wz-f">
        <span className="wz-l">{t("import.archive")}</span>
        <div className="wz-row">
          <input className="inp wz-ro" value={archive} readOnly placeholder="backup.zip" aria-label={t("import.archive")} />
          <button className="btn btn-small" onClick={() => void chooseArchive()}>
            {t("import.chooseArchive")}
          </button>
        </div>
      </div>

      <div className="wz-f">
        <span className="wz-l">{t("import.dest")}</span>
        <div className="wz-row">
          <input
            className="inp wz-ro"
            value={dest}
            readOnly
            placeholder="C:\projects\restored"
            aria-label={t("import.dest")}
          />
          <button className="btn btn-small" onClick={() => void chooseDest()}>
            {t("import.chooseDest")}
          </button>
        </div>
      </div>

      <label className="wz-f">
        <span className="wz-l">{t("import.passphrase")}</span>
        <div className="wz-row">
          <input
            className="inp"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <span className={`wz-count${enough ? " ok" : ""}`} aria-live="polite">
            {Math.min(passphrase.length, PASSPHRASE_MIN)} / {PASSPHRASE_MIN}
          </span>
        </div>
      </label>
    </WizardFrame>
  );
}
