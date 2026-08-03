import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { useGuardedMutation } from "../../hooks";
import type { SystemStatus } from "../../types";

export default function ImportForm({
  onCancel,
  onLoaded,
  onError,
}: {
  onCancel: () => void;
  onLoaded: (status: SystemStatus) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const [archive, setArchive] = useState("");
  const [dest, setDest] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const { busy, run } = useGuardedMutation(onError);

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
      onLoaded(await api.importBackup(archive, dest, passphrase));
    });
  }

  const ready = archive !== "" && dest !== "" && passphrase.length >= 8 && !busy;

  return (
    <div className="form">
      <h2 className="form-heading">{t("import.heading")}</h2>

      <label className="field">
        <span>{t("import.archive")}</span>
        <div className="field-row">
          <input value={archive} readOnly placeholder="backup.zip" />
          <button className="btn" onClick={() => void chooseArchive()}>
            {t("import.chooseArchive")}
          </button>
        </div>
      </label>

      <label className="field">
        <span>{t("import.dest")}</span>
        <div className="field-row">
          <input value={dest} readOnly placeholder="C:\projects\restored" />
          <button className="btn" onClick={() => void chooseDest()}>
            {t("import.chooseDest")}
          </button>
        </div>
      </label>

      <label className="field">
        <span>{t("import.passphrase")}</span>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </label>

      <div className="form-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!ready}>
          {busy ? t("import.running") : t("import.run")}
        </button>
      </div>
    </div>
  );
}
