/**
 * Warning only, never fails a deploy: the maintainer's production and staging Workers read the
 * drive settings from Cloudflare Secrets Store, whose SS_* bindings exist only in builds made with
 * DROP_SECRETS_STORE_ID set. The public template (`npm run deploy`) never calls this.
 */
export function warnIfNoStoreBindings(config, cookieKeySecretName) {
  try {
    const bindings = Array.isArray(config?.secrets_store_secrets) ? config.secrets_store_secrets : [];
    if (bindings.length > 0) return false;
    const line = "=".repeat(72);
    console.warn(
      [
        "",
        line,
        "⚠️  WARNING / 警告: no Secrets Store bindings in this build (DROP_SECRETS_STORE_ID unset)",
        line,
        "中文：这次构建没有 Secrets Store 绑定。部署后两个网盘都会显示「未开通」，局域网互传仍然正常。",
        "English: both drives will show as not configured (未开通) after this deploy; LAN transfer still works.",
        "",
        "修复 / Fix: export these in the same shell, then run the deploy again:",
        "  export DROP_SECRETS_STORE_ID=<store-id>",
        `  export DROP_COOKIE_KEY_SECRET_NAME=${cookieKeySecretName}`,
        "(Store ID: npx wrangler secrets-store store list --remote)",
        "部署不会被拦下 / The deploy continues.",
        line,
        "",
      ].join("\n"),
    );
    return true;
  } catch {
    return false;
  }
}
