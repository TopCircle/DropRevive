import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { getPack, t, useI18n } from "@/lib/i18n";
import { zhMessages } from "@/lib/i18n/packs/zh";
import { Toaster } from "sonner";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import appCss from "../styles.css?url";

const APP_NAME = "DropRevive";

function LocaleSync() {
  const { locale } = useI18n();
  useEffect(() => {
    const pack = getPack(locale);
    document.documentElement.lang = pack.htmlLang;
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
  }, [locale]);
  return null;
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content: zhMessages["meta.description"],
      },
      { name: "theme-color", content: "#1c1b17" },
      { name: "apple-mobile-web-app-title", content: APP_NAME },
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
      { property: "og:title", content: APP_NAME },
      { property: "og:description", content: zhMessages["meta.description"] },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=JSON.parse(localStorage.getItem("droprevive.settings")||"null");var t=(s&&s.theme)||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}try{var id=localStorage.getItem("droprevive.locale");var nav=(navigator.language||"").toLowerCase();document.documentElement.lang=(id==="en"||(!id&&nav.indexOf("en")===0))?"en":"zh-CN";}catch(e){}})();`,
          }}
        />
        <LocaleSync />
          <Outlet />
          {/* Above the composer, so toasts never cover the scope heading at the top. */}
          <Toaster
            position="bottom-center"
            offset={{ bottom: 160 }}
            mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 130px)" }}
            // An open dialog sets pointer-events: none on <body>; toast actions (e.g. 「重试」) must stay clickable.
            style={{ pointerEvents: "auto" }}
            toastOptions={{
              style: {
                background: "var(--bg-elev)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                fontFamily: "inherit",
              },
            }}
          />
        <Scripts />
      </body>
    </html>
  ),
});
