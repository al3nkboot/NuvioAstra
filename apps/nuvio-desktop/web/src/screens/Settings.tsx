// Settings of the active profile. Only options that NextGen applies for real are shown; each one
// is saved through Rust (`settings_set`, validated into the original's ranges) and read back.
// The original's other settings pages are listed under "Ainda não disponível" (no controls).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccountLine as AccountIcon, AddonsLine as AddonsIcon, AudioLine as AudioIcon, HomeLine as HomeIcon, P2pLine as P2pIcon,
  PendingLine as PendingIcon, PlaybackLine as PlaybackIcon, ProfileDataLine as ProfileDataIcon, SubtitlesLine as SubtitlesIcon, UpdatesLine as UpdatesIcon,
} from "../components/SidebarIcons";
import { api, errorText } from "../api";
import { AccountPanel } from "../components/AccountPanel";
import { AddonsManager } from "../components/AddonsManager";
import { checkForUpdates, installUpdate, useUpdates } from "../updates";
import { Avatar } from "../components/ProfileMenu";
import { LANGUAGES } from "../languages";
import { p2pConsentText, megabytes } from "../components/TorrentStart";
import { locale, localizeCatalogTitle, useI18n, type TranslationKey } from "../i18n";
import type { CatalogChoice, P2pCacheName, P2pProfileName, P2pSettings, PlayerSettings, ProfileSettings, ResizeModeName, SettingsView, SubtitleSettings } from "../types";

type Section = "account" | "home" | "addons" | "playback" | "p2p" | "audio" | "subtitles" | "data" | "updates" | "pending";

const SECTIONS: { id: Section; labelKey: TranslationKey; icon: ReactNode }[] = [
  { id: "account", labelKey: "settings.sectionAccount", icon: <AccountIcon /> },
  { id: "home", labelKey: "settings.sectionHome", icon: <HomeIcon /> },
  { id: "addons", labelKey: "settings.sectionAddons", icon: <AddonsIcon /> },
  { id: "playback", labelKey: "settings.sectionPlayback", icon: <PlaybackIcon /> },
  { id: "p2p", labelKey: "settings.sectionP2p", icon: <P2pIcon /> },
  { id: "audio", labelKey: "settings.sectionAudio", icon: <AudioIcon /> },
  { id: "subtitles", labelKey: "settings.sectionSubtitles", icon: <SubtitlesIcon /> },
  { id: "data", labelKey: "settings.sectionData", icon: <ProfileDataIcon /> },
  { id: "updates", labelKey: "settings.sectionUpdates", icon: <UpdatesIcon /> },
  { id: "pending", labelKey: "settings.sectionPending", icon: <PendingIcon /> },
];

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; note?: string } | { kind: "error"; message: string };

// ---------- small controls ----------

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {description && <div className="muted small">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}

function Slider({ value, min, max, onChange, unit, label }: { value: number; min: number; max: number; onChange(v: number): void; unit?: string; label: string }) {
  return (
    <span className="slider">
      <input type="range" min={min} max={max} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{value}{unit}</output>
    </span>
  );
}

/** `#AARRGGBB` ⇄ color input (`#rrggbb`) + optional opacity. */
function ColorField({ value, onChange, withOpacity, label }: { value: string; onChange(v: string): void; withOpacity?: boolean; label: string }) {
  const { t } = useI18n();
  const alpha = value.slice(1, 3);
  const rgb = `#${value.slice(3, 9).toLowerCase()}`;
  const opacity = Math.round((parseInt(alpha, 16) / 255) * 100);
  const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
  return (
    <span className="color-field">
      <input type="color" value={rgb} aria-label={label} onChange={(e) => onChange(`#${alpha}${e.target.value.slice(1).toUpperCase()}`)} />
      {withOpacity && (
        <Slider label={t("settings.opacity", { label })} value={opacity} min={0} max={100} unit="%" onChange={(o) => onChange(`#${hex2((o / 100) * 255)}${value.slice(3)}`)} />
      )}
    </span>
  );
}

function LanguageSelect({ value, onChange, special, label }: { value: string | null; onChange(v: string | null): void; special: [string, string][]; label: string }) {
  const known = LANGUAGES.some(([c]) => c.toLowerCase() === (value ?? "").toLowerCase()) || special.some(([c]) => c === (value ?? ""));
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {special.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      {!known && value && <option value={value}>{value}</option>}
      {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
    </select>
  );
}

// ---------- page ----------

export function Settings() {
  const { t, language, setLanguage } = useI18n();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<ProfileSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("home");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const timer = useRef<number>(0);
  const pending = useRef<{ next: ProfileSettings; note?: string } | null>(null);
  /** Latest settings, including changes not rendered yet (several quick changes in a row). */
  const draftRef = useRef<ProfileSettings | null>(null);

  useEffect(() => {
    api.settingsGet().then(
      (v) => {
        setView(v);
        draftRef.current = v.settings;
        setDraft(v.settings);
      },
      (e) => setError(errorText(e)),
    );
  }, []);

  const flush = useCallback(async () => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    setStatus({ kind: "saving" });
    try {
      const saved = await api.settingsSet(job.next);
      // Rust may have corrected a value (ranges of the original): show what was stored, unless
      // the user changed something else meanwhile (that change is saved next).
      if (draftRef.current === job.next) {
        draftRef.current = saved;
        setDraft(saved);
      }
      if (!pending.current) setStatus({ kind: "saved", note: job.note });
    } catch (e) {
      setStatus({ kind: "error", message: errorText(e) });
    }
  }, []);

  // Leaving the page (or the app tab) never drops a change still waiting for its debounce.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  /** Applies a change locally and saves it (debounced for sliders and typing). */
  const update = useCallback(
    (change: (s: ProfileSettings) => ProfileSettings, note?: string, delay = 300) => {
      const current = pending.current?.next ?? draftRef.current;
      if (!current) return;
      const next = change(current);
      draftRef.current = next;
      pending.current = { next, note };
      setDraft(next);
      setStatus({ kind: "saving" });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  const player = (change: (p: PlayerSettings) => PlayerSettings) =>
    update((s) => ({ ...s, player: change(s.player) }), t("settings.nextPlayback"));
  const subtitle = (change: (p: SubtitleSettings) => SubtitleSettings) => player((p) => ({ ...p, subtitle: change(p.subtitle) }));

  const resetSection = (what: Section) => {
    if (!view || !draft) return;
    const name = t(SECTIONS.find((s) => s.id === what)?.labelKey ?? "settings.sectionHome");
    if (!window.confirm(t("settings.resetConfirm", { section: name, profile: view.profile.name }))) return;
    const d = view.defaults;
    update((s) => {
      switch (what) {
        case "home": return { ...s, home: { ...d.home } };
        case "playback": return { ...s, player: { ...s.player, resizeMode: d.player.resizeMode, decoderPriority: d.player.decoderPriority, nvidiaRtxSuperResolution: d.player.nvidiaRtxSuperResolution, nvidiaRtxHdr: d.player.nvidiaRtxHdr } };
        case "audio": return { ...s, player: { ...s.player, preferredAudioLanguage: d.player.preferredAudioLanguage, secondaryPreferredAudioLanguage: d.player.secondaryPreferredAudioLanguage } };
        case "subtitles": return { ...s, player: { ...s.player, preferredSubtitleLanguage: d.player.preferredSubtitleLanguage, secondaryPreferredSubtitleLanguage: d.player.secondaryPreferredSubtitleLanguage, subtitle: { ...d.player.subtitle } } };
        default: return s;
      }
    }, t("settings.defaultsRestored"), 0);
  };

  if (error) return <div className="screen-message">{t("settings.openError", { error })}</div>;
  if (!view || !draft) return <div className="screen-message">{t("settings.loading")}</div>;
  const p = draft.player;
  const sub = p.subtitle;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.aria")}>
        <div className="settings-profile">
          <Avatar profile={view.profile} />
          <div>
            <div className="setting-title">{view.profile.name}</div>
            <div className="muted small">{t("settings.profileSettings")}</div>
          </div>
        </div>
        <label className="settings-language">
          <span className="muted small">{t("settings.language")}</span>
          <select
            data-testid="ui-language"
            aria-label={t("settings.language")}
            value={language}
            onChange={(e) => setLanguage(e.target.value === "pt" ? "pt" : e.target.value === "ar" ? "ar" : "en")}
          >
            <option value="en">English</option>
            <option value="pt">Português</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        {SECTIONS.map((s) => (
          <button key={s.id} className={`nav-item ${section === s.id ? "active" : ""}`} data-section={s.id} onClick={() => setSection(s.id)}>
            <span className="nav-icon" aria-hidden>{s.icon}</span>
            <span>{t(s.labelKey)}</span>
          </button>
        ))}
      </nav>

      <div className="settings-body" key={section}>
        <header className="settings-header">
          <h1>{t(SECTIONS.find((s) => s.id === section)?.labelKey ?? "settings.sectionHome")}</h1>
          <span className={`save-status ${status.kind}`} role="status" data-testid="save-status">
            {status.kind === "saving" && t("settings.saving")}
            {status.kind === "saved" && `${t("settings.saved")}${status.note ? ` · ${status.note}` : ""}`}
            {status.kind === "error" && t("settings.saveError", { error: status.message })}
          </span>
          {["home", "playback", "audio", "subtitles"].includes(section) && (
            <button className="ghost" onClick={() => resetSection(section)}>{t("settings.restoreDefaults")}</button>
          )}
        </header>

        {section === "home" && (
          <HomeSection settings={draft} catalogs={view.catalogs} update={update} />
        )}

        {section === "account" && <AccountPanel />}
        {section === "addons" && <AddonsManager />}

        {section === "playback" && (
          <div className="settings-group">
            <Row title={t("settings.resizeMode")} description={t("settings.resizeModeDesc")}>
              <select aria-label={t("settings.resizeMode")} data-setting="resizeMode" value={p.resizeMode} onChange={(e) => player((x) => ({ ...x, resizeMode: e.target.value as ResizeModeName }))}>
                <option value="Fit">{t("settings.resize.fit")}</option>
                <option value="Fill">{t("settings.resize.fill")}</option>
                <option value="Zoom">{t("settings.resize.zoom")}</option>
                <option value="Stretch">{t("settings.resize.stretch")}</option>
              </select>
            </Row>
            <Row title={t("settings.decoder")} description={t("settings.decoderDesc")}>
              <select aria-label={t("settings.decoder")} data-setting="decoderPriority" value={p.decoderPriority} onChange={(e) => player((x) => ({ ...x, decoderPriority: Number(e.target.value) }))}>
                <option value={1}>{t("settings.decoderHardwareFallback")}</option>
                <option value={0}>{t("settings.decoderHardwareOnly")}</option>
                <option value={2}>{t("settings.decoderSoftwareOnly")}</option>
              </select>
            </Row>
            <Row title="NVIDIA RTX Video Super Resolution" description={t("settings.rtxSuperResolutionDesc")}>
              <Toggle label="NVIDIA RTX Video Super Resolution" checked={p.nvidiaRtxSuperResolution} onChange={(v) => player((x) => ({ ...x, nvidiaRtxSuperResolution: v }))} />
            </Row>
            <Row title="NVIDIA RTX Video HDR" description={t("settings.rtxHdrDesc")}>
              <Toggle label="NVIDIA RTX Video HDR" checked={p.nvidiaRtxHdr} onChange={(v) => player((x) => ({ ...x, nvidiaRtxHdr: v }))} />
            </Row>
          </div>
        )}

        {section === "p2p" && <P2pSection settings={draft.p2p} update={(change) => update((s) => ({ ...s, p2p: change(s.p2p) }), t("settings.nextTorrent"), 0)} />}

        {section === "audio" && (
          <div className="settings-group">
            <Row title={t("settings.audioPreferred")} description={t("settings.audioDeviceDesc", { languages: view.deviceLanguages.join(", ") || t("settings.audioNotIdentified") })}>
              <LanguageSelect label={t("settings.audioPreferred")} value={p.preferredAudioLanguage} special={[["device", t("settings.deviceLanguage")], ["default", t("settings.fileDefault")], ["original", t("settings.originalLanguage")]]} onChange={(v) => player((x) => ({ ...x, preferredAudioLanguage: v ?? "device" }))} />
            </Row>
            <Row title={t("settings.audioSecondary")} description={t("settings.audioSecondaryDesc")}>
              <LanguageSelect label={t("settings.audioSecondary")} value={p.secondaryPreferredAudioLanguage} special={[["", t("settings.none")]]} onChange={(v) => player((x) => ({ ...x, secondaryPreferredAudioLanguage: v }))} />
            </Row>
            <p className="muted small pad-top">{t("settings.audioOriginalHint")}</p>
          </div>
        )}

        {section === "subtitles" && (
          <div className="settings-group">
            <Row title={t("settings.subtitlePreferred")}>
              <LanguageSelect label={t("settings.subtitlePreferred")} value={p.preferredSubtitleLanguage} special={[["none", t("settings.subtitleNoneForced")], ["device", t("settings.deviceLanguage")], ["forced", t("settings.subtitleForcedOnly")]]} onChange={(v) => player((x) => ({ ...x, preferredSubtitleLanguage: v ?? "none" }))} />
            </Row>
            <Row title={t("settings.subtitleSecondary")}>
              <LanguageSelect label={t("settings.subtitleSecondary")} value={p.secondaryPreferredSubtitleLanguage} special={[["", t("settings.none")]]} onChange={(v) => player((x) => ({ ...x, secondaryPreferredSubtitleLanguage: v }))} />
            </Row>
            <div className="subtitle-preview" aria-hidden>
              <span
                style={{
                  color: `#${sub.textColor.slice(3)}`,
                  opacity: parseInt(sub.textColor.slice(1, 3), 16) / 255,
                  fontSize: `${Math.max(11, sub.fontSizeSp)}px`,
                  fontWeight: sub.bold ? 700 : 400,
                  background: `rgba(${parseInt(sub.backgroundColor.slice(3, 5), 16)},${parseInt(sub.backgroundColor.slice(5, 7), 16)},${parseInt(sub.backgroundColor.slice(7, 9), 16)},${parseInt(sub.backgroundColor.slice(1, 3), 16) / 255})`,
                  WebkitTextStroke: sub.outlineEnabled ? `${sub.outlineWidth / 2}px #${sub.outlineColor.slice(3)}` : undefined,
                  bottom: `${8 + sub.bottomOffset / 5}px`,
                }}
              >
                {t("settings.subtitleExample")}
              </span>
            </div>
            <Row title={t("settings.subtitleSize")}><Slider label={t("settings.subtitleSizeLabel")} value={sub.fontSizeSp} min={6} max={40} onChange={(v) => subtitle((s) => ({ ...s, fontSizeSp: v }))} /></Row>
            <Row title={t("settings.subtitleBottom")}><Slider label={t("settings.subtitleBottom")} value={sub.bottomOffset} min={0} max={200} onChange={(v) => subtitle((s) => ({ ...s, bottomOffset: v }))} /></Row>
            <Row title={t("settings.subtitleTextColor")}><ColorField label={t("settings.subtitleTextColor")} value={sub.textColor} onChange={(v) => subtitle((s) => ({ ...s, textColor: v }))} /></Row>
            <Row title={t("settings.subtitleBold")}><Toggle label={t("settings.subtitleBold")} checked={sub.bold} onChange={(v) => subtitle((s) => ({ ...s, bold: v }))} /></Row>
            <Row title={t("settings.subtitleOutline")}><Toggle label={t("settings.subtitleOutline")} checked={sub.outlineEnabled} onChange={(v) => subtitle((s) => ({ ...s, outlineEnabled: v }))} /></Row>
            {sub.outlineEnabled && (
              <>
                <Row title={t("settings.subtitleOutlineColor")}><ColorField label={t("settings.subtitleOutlineColor")} value={sub.outlineColor} onChange={(v) => subtitle((s) => ({ ...s, outlineColor: v }))} /></Row>
                <Row title={t("settings.subtitleOutlineWidth")}><Slider label={t("settings.subtitleOutlineWidth")} value={sub.outlineWidth} min={1} max={5} onChange={(v) => subtitle((s) => ({ ...s, outlineWidth: v }))} /></Row>
              </>
            )}
            <Row title={t("settings.subtitleBackground")}><ColorField label={t("settings.subtitleBackgroundColor")} withOpacity value={sub.backgroundColor} onChange={(v) => subtitle((s) => ({ ...s, backgroundColor: v }))} /></Row>
            <Row title={t("settings.subtitleStripSdh")} description={t("settings.subtitleStripSdhDesc")}>
              <Toggle label={t("settings.subtitleStripSdhLabel")} checked={sub.stripSdh} onChange={(v) => subtitle((s) => ({ ...s, stripSdh: v }))} />
            </Row>
          </div>
        )}

        {section === "data" && (
          <div className="settings-group">
            <div className="about" data-testid="about">
              <img src="./nuvio-astra-128.png" alt="" width={56} height={56} draggable={false} />
              <div>
                <div className="about-name">Nuvio Astra</div>
                <div className="muted small">{t("settings.dataVersion", { version: view.appVersion })}</div>
              </div>
            </div>
            <Row title={t("settings.dataActiveProfile")} description={t("settings.dataActiveProfileDesc")}>
              <span>{view.profile.name}</span>
            </Row>
            <Row title={t("settings.dataFolder")} description={t("settings.dataFolderDesc")}>
              <code className="path">{view.dataDir}</code>
            </Row>
            {view.migration && (
              <>
                <Row title={t("settings.dataMigration")} description={t("settings.dataMigrationDesc")}>
                  <span>
                    {t("settings.dataMigrationValues", {
                      version: view.migration.version,
                      files: view.migration.backupFiles,
                      profiles: view.migration.profiles,
                      settingsProfiles: view.migration.settingsProfiles ?? 0,
                    })}
                  </span>
                </Row>
                <Row title={t("settings.dataBackupVerified")}><code className="path">{view.migration.backupDir}</code></Row>
              </>
            )}
          </div>
        )}

        {section === "updates" && <UpdatesSection />}

        {section === "pending" && (
          <div className="settings-group">
            <p className="muted">{t("settings.pendingText")}</p>
            <ul className="pending-list">
              <li>{t("settings.pendingDetails")}</li>
              <li>{t("settings.pendingContinue")}</li>
              <li>{t("settings.pendingSources")}</li>
              <li>{t("settings.pendingNextEpisode")}</li>
              <li>{t("settings.pendingSubtitles")}</li>
              <li>{t("settings.pendingPlayer")}</li>
              <li>{t("settings.pendingDebrid")}</li>
              <li>{t("settings.pendingIntegrations")}</li>
              <li>{t("settings.pendingPlugins")}</li>
              <li>{t("settings.pendingSync")}</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Atualizações ----------

function UpdatesSection() {
  const { t } = useI18n();
  const u = useUpdates();
  const s = u.status;
  const when = u.lastCheck ? new Date(u.lastCheck).toLocaleString(locale(), { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : null;
  return (
    <div className="settings-group" data-testid="updates-settings">
      <Row title={t("settings.updatesInstalled")} description={s?.repository ? t("settings.updatesRepo", { repository: s.repository }) : undefined}>
        <span>{s?.currentVersion ?? "…"}</span>
      </Row>
      {s && !s.configured && <p className="muted">{t("settings.updatesNotConfigured")}</p>}
      {s?.configured && (
        <>
          <Row title={t("settings.updatesCheck")} description={t("settings.updatesCheckDesc")}>
            <button className="ghost" disabled={u.checking || !!u.installing} onClick={() => void checkForUpdates()} data-testid="update-check">
              {u.checking ? t("settings.updatesChecking") : t("settings.updatesCheckNow")}
            </button>
          </Row>
          {u.checkError && <div className="row-error">{u.checkError}</div>}
          {!u.checking && !u.checkError && u.lastCheck && !u.available && <div className="addon-feedback ok" role="status">{t("settings.updatesUpToDate", { when: when ?? "" })}</div>}
          {u.available && (
            <div className="update-card">
              <div className="setting-title">{t("settings.updatesNewVersion", { version: u.available.version })}</div>
              {u.available.notes && <pre className="update-notes">{u.available.notes}</pre>}
              <div className="account-actions">
                <button className="primary" disabled={!!u.installing && u.installing.phase !== "error"} onClick={() => void installUpdate()}>
                  {u.installing && u.installing.phase !== "error" ? t("settings.updatesUpdating") : t("settings.updatesUpdateNow")}
                </button>
              </div>
              {u.installing?.phase === "error" && <div className="row-error">{u.installing.error}</div>}
            </div>
          )}
          <p className="muted small">{t("settings.updatesKeeps")}</p>
        </>
      )}
    </div>
  );
}

// ---------- Torrent / P2P ----------

function P2pSection({ settings, update }: { settings: P2pSettings; update(change: (s: P2pSettings) => P2pSettings): void }) {
  const { t } = useI18n();
  const [cache, setCache] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.p2pCacheSize().then(setCache, () => setCache(null));
  }, []);

  const enable = (on: boolean) => {
    if (on && !window.confirm(p2pConsentText().join("\n\n"))) return;
    update((s) => ({ ...s, enabled: on }));
  };
  const clear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const freed = await api.p2pClearCache();
      setMessage(t("settings.p2pCleared", { size: megabytes(freed) }));
      setCache(await api.p2pCacheSize());
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-group" data-testid="p2p-settings">
      <Row title={t("settings.p2pStreaming")} description={t("settings.p2pStreamingDesc")}>
        <Toggle label={t("settings.p2pStreaming")} checked={settings.enabled} onChange={enable} />
      </Row>
      <Row title={t("settings.p2pUpload")} description={t("settings.p2pUploadDesc")}>
        <Toggle label={t("settings.p2pUploadLabel")} checked={settings.enableUpload} onChange={(v) => update((s) => ({ ...s, enableUpload: v }))} />
      </Row>
      <Row title={t("settings.p2pHideStats")} description={t("settings.p2pHideStatsDesc")}>
        <Toggle label={t("settings.p2pHideStatsLabel")} checked={settings.hideTorrentStats} onChange={(v) => update((s) => ({ ...s, hideTorrentStats: v }))} />
      </Row>
      <Row title={t("settings.p2pProfile")} description={t("settings.p2pProfileDesc")}>
        <select aria-label={t("settings.p2pProfile")} value={settings.torrentProfile} onChange={(e) => update((s) => ({ ...s, torrentProfile: e.target.value as P2pProfileName }))}>
          <option value="SOFT">{t("settings.p2pProfileLight")}</option>
          <option value="BALANCED">{t("settings.p2pProfileBalanced")}</option>
          <option value="FAST">{t("settings.p2pProfileFast")}</option>
        </select>
      </Row>
      <Row title={t("settings.p2pCacheSize")} description={t("settings.p2pCacheSizeDesc")}>
        <select aria-label={t("settings.p2pCacheSize")} value={settings.cacheSize} onChange={(e) => update((s) => ({ ...s, cacheSize: e.target.value as P2pCacheName }))}>
          <option value="NONE">{t("settings.p2pCacheNone")}</option>
          <option value="GB_2">{t("settings.p2pCache2")}</option>
          <option value="GB_5">{t("settings.p2pCache5")}</option>
          <option value="GB_10">{t("settings.p2pCache10")}</option>
        </select>
      </Row>
      <Row title={t("settings.p2pCacheInUse")} description={t("settings.p2pCacheInUseDesc")}>
        <span className="account-actions" style={{ marginTop: 0 }}>
          <span>{cache === null ? "—" : megabytes(cache)}</span>
          <button className="ghost" disabled={busy} onClick={() => void clear()}>{busy ? t("settings.p2pClearing") : t("settings.p2pClear")}</button>
        </span>
      </Row>
      {message && <div className="addon-feedback ok" role="status">{message}</div>}
    </div>
  );
}

// ---------- Início ----------

function HomeSection({ settings, catalogs, update }: {
  settings: ProfileSettings;
  catalogs: CatalogChoice[];
  update(change: (s: ProfileSettings) => ProfileSettings, note?: string, delay?: number): void;
}) {
  const { t } = useI18n();
  const note = t("settings.homeUpdated");
  const home = settings.home;
  // Current order: saved preferences first (by order), then catalogs without one.
  const ordered = [...catalogs].sort((a, b) => {
    const pa = home.items.find((i) => i.key === a.key)?.order ?? Number.MAX_SAFE_INTEGER;
    const pb = home.items.find((i) => i.key === b.key)?.order ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || catalogs.indexOf(a) - catalogs.indexOf(b);
  });
  const pref = (c: CatalogChoice) => home.items.find((i) => i.key === c.key);

  /** Rewrites the preference list for every catalog, in `order`, keeping hero-source flags. */
  const saveCatalogs = (order: CatalogChoice[], patch?: { key: string; enabled?: boolean; customTitle?: string }, delay?: number) =>
    update(
      (s) => ({
        ...s,
        home: {
          ...s.home,
          items: order.map((c, index) => {
            const old = s.home.items.find((i) => i.key === c.key);
            const base = { key: c.key, customTitle: old?.customTitle ?? c.customTitle, enabled: old?.enabled ?? c.enabled, heroSourceEnabled: old?.heroSourceEnabled ?? true, order: index };
            return patch && patch.key === c.key ? { ...base, ...(patch.enabled !== undefined && { enabled: patch.enabled }), ...(patch.customTitle !== undefined && { customTitle: patch.customTitle }) } : base;
          }),
        },
      }),
      note,
      delay,
    );

  const move = (index: number, dir: -1 | 1) => {
    const next = [...ordered];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item);
    saveCatalogs(next, undefined, 0);
  };

  return (
    <>
      <div className="settings-group">
        <Row title={t("settings.homeHero")} description={t("settings.homeHeroDesc")}>
          <Toggle label={t("settings.homeHero")} checked={home.heroEnabled} onChange={(v) => update((s) => ({ ...s, home: { ...s.home, heroEnabled: v } }), note)} />
        </Row>
        <Row title={t("settings.homeShowType")} description={t("settings.homeShowTypeDesc")}>
          <Toggle label={t("settings.homeShowType")} checked={home.showCatalogType} onChange={(v) => update((s) => ({ ...s, home: { ...s.home, showCatalogType: v } }), note)} />
        </Row>
        <Row title={t("settings.homeHideUnreleased")} description={t("settings.homeHideUnreleasedDesc")}>
          <Toggle label={t("settings.homeHideUnreleased")} checked={home.hideUnreleasedContent} onChange={(v) => update((s) => ({ ...s, home: { ...s.home, hideUnreleasedContent: v } }), note)} />
        </Row>
      </div>
      <h2 className="settings-subtitle">{t("settings.homeCatalogs", { visible: ordered.filter((c) => pref(c)?.enabled ?? c.enabled).length, total: ordered.length })}</h2>
      <div className="settings-group catalogs">
        {ordered.map((c, index) => {
          const enabled = pref(c)?.enabled ?? c.enabled;
          const title = pref(c)?.customTitle ?? c.customTitle;
          const defaultTitle = localizeCatalogTitle(c.defaultTitle);
          return (
            <div key={c.key} className={`catalog-pref ${enabled ? "" : "off"}`} data-key={c.key}>
              <Toggle label={t("settings.homeShowCatalog", { title: defaultTitle })} checked={enabled} onChange={(v) => saveCatalogs(ordered, { key: c.key, enabled: v }, 0)} />
              <div className="catalog-pref-text">
                <input
                  className="catalog-title-input"
                  value={title}
                  placeholder={defaultTitle}
                  aria-label={t("settings.homeCatalogName", { title: defaultTitle })}
                  onChange={(e) => saveCatalogs(ordered, { key: c.key, customTitle: e.target.value }, 600)}
                />
                <span className="muted small">{c.addonName}</span>
              </div>
              <button className="icon-btn" aria-label={t("settings.homeMoveUp", { title: defaultTitle })} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button className="icon-btn" aria-label={t("settings.homeMoveDown", { title: defaultTitle })} disabled={index === ordered.length - 1} onClick={() => move(index, 1)}>↓</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
