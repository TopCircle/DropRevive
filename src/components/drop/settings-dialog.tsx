import * as Dialog from "@radix-ui/react-dialog";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useCallback, useState, type UIEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { googleConfigured, microsoftConfigured } from "@/lib/drop/client-env";
import { startConnect } from "@/lib/drop/drive-token";
import { edgeFadeMask, sameEdges, scrollEdges, type ScrollEdges } from "@/lib/drop/scroll-edges";
import { useDropStore } from "@/lib/drop/store";
import type { ThemeMode } from "@/lib/drop/types";
import { listPacks, setLocale, useI18n } from "@/lib/i18n";
import { splitPlaceholder } from "@/lib/i18n/rich";

export function SettingsDialog() {
  const open = useDropStore((state) => state.settingsOpen);
  const closeSettings = useDropStore((state) => state.closeSettings);
  const settings = useDropStore((state) => state.settings);
  const patchSettings = useDropStore((state) => state.patchSettings);
  const google = useDropStore((state) => state.google);
  const microsoft = useDropStore((state) => state.microsoft);
  const disconnect = useDropStore((state) => state.disconnect);
  const clearCache = useDropStore((state) => state.clearCache);
  const busy = useDropStore((state) => state.busy);
  const authError = useDropStore((state) => state.authError);
  const clearAuthError = useDropStore((state) => state.clearAuthError);
  const [working, setWorking] = useState<"google" | "microsoft" | null>(null);
  const { t, locale } = useI18n();
  const edges = useScrollEdges();

  // A saved access token stays「已连接」. The Worker renews it only when it is about to lapse.
  const googleOn = Boolean(google);
  const microsoftOn = Boolean(microsoft);

  // The page leaves for the provider. The Worker brings it back to /?connected=… or ?auth_error=….
  function launch(provider: "google" | "microsoft") {
    setWorking(provider);
    clearAuthError();
    startConnect(provider, provider === "google" ? google?.email : microsoft?.username);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && closeSettings()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
        <Dialog.Content
          data-settings-dialog=""
          // A toast action (「重试」 after a failed disconnect) is not a click outside: keep settings open.
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-sonner-toaster]")) event.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-card py-5 pr-1.5">
          {/* Opaque, with its own bottom padding. The hairline under it shows only once the list
              has scrolled, so at rest the header and list read as one surface. */}
          <div className="relative flex shrink-0 items-start justify-between gap-3 bg-card pb-3 pl-5 pr-3.5">
            <div>
              <Dialog.Title className="text-lg font-medium">{t("settings.title")}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {t("settings.lead")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("settings.close")}>
                <X className="size-4" />
              </Button>
            </Dialog.Close>
            <span
              aria-hidden="true"
              data-settings-divider="top"
              className={`pointer-events-none absolute bottom-0 left-0 -right-1.5 h-px bg-border transition-opacity duration-150 ${edges.state.above ? "opacity-100" : "opacity-0"}`}
            />
          </div>

          {/* Scrolls inside the rounded panel, so the scrollbar never clips its corners. Content
              past an edge fades out over 14px instead of being cut mid-line. */}
          <div
            ref={edges.ref}
            onScroll={edges.onScroll}
            style={{ maskImage: edgeFadeMask(edges.state), WebkitMaskImage: edgeFadeMask(edges.state) }}
            className="scrollbar-pill min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-5 pr-3.5"
          >
            <div data-settings-body="">
              <label className="mt-2 block">
                <span className="text-sm font-medium">{t("settings.deviceName")}</span>
                <input
                  value={settings.deviceName}
                  maxLength={40}
                  onChange={(event) => patchSettings({ deviceName: event.target.value })}
                  className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none"
                />
                <span className="mt-1 block text-xs text-subtle">{t("settings.deviceHint", { name: settings.deviceName || t("device.this") })}</span>
              </label>

              <fieldset className="mt-5">
                <legend className="text-sm font-medium">{t("settings.appearance")}</legend>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {(
                    [
                      ["system", t("settings.theme.system")],
                      ["light", t("settings.theme.light")],
                      ["dark", t("settings.theme.dark")],
                    ] as const
                  ).map(([id, label]) => (
                    <Choice
                      key={id}
                      active={settings.theme === id}
                      label={label}
                      onClick={() => patchSettings({ theme: id as ThemeMode })}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className="mt-5">
                <legend className="text-sm font-medium">{t("settings.language")}</legend>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  {listPacks().map((pack) => (
                    <Choice key={pack.id} active={locale === pack.id} label={pack.label} onClick={() => setLocale(pack.id)} />
                  ))}
                </div>
              </fieldset>

              <section className="mt-5 rounded-2xl border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium">Google Drive</h3>
                  <Status configured={googleConfigured} connected={googleOn} />
                </div>
                {google?.email && <p className="mt-1 truncate text-sm">{t("settings.account", { name: google.email })}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  {googleConfigured ? t("settings.googleScope") : <SetupLinked text={t("settings.googleOff")} onOpen={closeSettings} />}
                </p>
                <div className="mt-3">
                  <Button className="w-full" disabled={!googleConfigured || busy || working !== null} onClick={() => launch("google")}>
                    {working === "google" ? t("settings.connectingGoogle") : googleOn ? t("settings.reconnectGoogle") : t("settings.connectGoogle")}
                  </Button>
                  {googleOn && (
                    <Button variant="outline" className="mt-2 w-full" onClick={() => void disconnect("google")}>
                      {t("settings.disconnect")}
                    </Button>
                  )}
                </div>
              </section>

              <section className="mt-3 rounded-2xl border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium">OneDrive</h3>
                  <Status configured={microsoftConfigured} connected={microsoftOn} />
                </div>
                {microsoft?.username && <p className="mt-1 truncate text-sm">{t("settings.account", { name: microsoft.username })}</p>}
                <p className="mt-2 text-xs text-muted-foreground">
                  {microsoftConfigured ? t("settings.microsoftScope") : <SetupLinked text={t("settings.microsoftOff")} onOpen={closeSettings} />}
                </p>
                <div className="mt-3">
                  <Button className="w-full" disabled={!microsoftConfigured || busy || working !== null} onClick={() => launch("microsoft")}>
                    {working === "microsoft" ? t("settings.connectingMicrosoft") : microsoftOn ? t("settings.reconnectMicrosoft") : t("settings.connectMicrosoft")}
                  </Button>
                  {microsoftOn && (
                    <Button variant="outline" className="mt-2 w-full" onClick={() => void disconnect("microsoft")}>
                      {t("settings.disconnect")}
                    </Button>
                  )}
                </div>
              </section>

              {(!googleOn || !microsoftOn) && (
                <p data-privacy-consent="" className="mt-2 px-1 text-xs text-subtle">
                  {t("settings.consent")}
                  <a href="/privacy" className="underline underline-offset-4 hover:text-foreground">
                    {t("settings.consentLink")}
                  </a>
                  {t("settings.consentEnd")}
                </p>
              )}

              {authError && (
                <section className="mt-3 rounded-2xl border border-danger/40 bg-danger/5 p-3">
                  <p className="text-sm font-medium text-danger">
                    {t("settings.authFailed", { provider: authError.provider === "google" ? "Google" : "Microsoft" })}
                  </p>
                  <p className="mt-2 text-xs">{t("settings.authRetry")}</p>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {authError.code}
                    {authError.description ? `${t("settings.colon")}${authError.description}` : ""}
                  </p>
                </section>
              )}

              <section className="mt-5 border-t border-border pt-4">
                <h3 className="text-sm font-medium">{t("settings.local")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.cacheHint")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    void clearCache().then(() => toast.success(t("settings.cacheCleared")))
                  }
                >
                  {t("settings.clearCache")}
                </Button>
              </section>
            </div>
          </div>
          <p data-settings-footer="" className="relative shrink-0 pt-3 text-center text-xs text-subtle">
            <span
              aria-hidden="true"
              data-settings-divider="bottom"
              className={`pointer-events-none absolute top-0 left-0 -right-1.5 h-px bg-border transition-opacity duration-150 ${edges.state.below ? "opacity-100" : "opacity-0"}`}
            />
            {t("settings.version", { version: __APP_VERSION__, rev: __APP_REVISION__ })}
            <span aria-hidden="true"> · </span>
            <a href="/privacy" className="underline underline-offset-4 hover:text-foreground">
              {t("settings.privacy")}
            </a>
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Choice({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-xl text-sm ${active ? "bg-accent text-accent-foreground" : "bg-muted text-foreground"}`}
    >
      {label}
    </button>
  );
}

function Status({ configured, connected }: { configured: boolean; connected: boolean }) {
  const { t } = useI18n();
  const label = !configured ? t("settings.unavailable") : connected ? t("settings.connected") : t("settings.notConnected");
  return <span className={`text-xs ${connected ? "text-ok" : "text-subtle"}`}>{label}</span>;
}

// Tracks whether the settings list has content hidden above or below. Re-measures on scroll and
// whenever the box or its content resizes (a drive connects, an error shows, the window turns).
// The dialog content unmounts on close, so every open starts from a fresh measurement.
function useScrollEdges() {
  const [state, setState] = useState<ScrollEdges>({ above: false, below: false });
  const measure = useCallback((node: HTMLElement) => {
    const next = scrollEdges(node);
    setState((prev) => (sameEdges(prev, next) ? prev : next));
  }, []);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      measure(node);
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => measure(node));
      observer.observe(node);
      if (node.firstElementChild) observer.observe(node.firstElementChild);
      return () => observer.disconnect();
    },
    [measure],
  );
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => measure(event.currentTarget), [measure]);
  return { state, ref, onScroll };
}

/** Renders a message's `{setup}` placeholder as an in-app link to /setup. */
function SetupLinked({ text, onOpen }: { text: string; onOpen: () => void }) {
  const parts = splitPlaceholder(text, "setup");
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && (
            <Link data-setup-link="" to="/setup" onClick={onOpen} className="underline underline-offset-4 hover:text-foreground">
              /setup
            </Link>
          )}
        </span>
      ))}
    </>
  );
}
