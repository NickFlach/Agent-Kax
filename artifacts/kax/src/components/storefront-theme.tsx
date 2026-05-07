import type { CSSProperties, ReactNode } from "react";

export interface StorefrontThemeSettings {
  themeVariant: "dark" | "light";
  accentColor?: string | null;
  customCssVars?: Record<string, string> | null;
}

const ALLOWED_CSS_VARS = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--radius",
  "--font-family",
]);

export function buildThemeStyle(settings: StorefrontThemeSettings): CSSProperties {
  const style: Record<string, string> = {};
  if (settings.themeVariant === "light") {
    style["--background"] = "#fafafa";
    style["--foreground"] = "#0a0a0a";
    style["--card"] = "#ffffff";
    style["--card-foreground"] = "#0a0a0a";
    style["--muted"] = "#f1f1f1";
    style["--muted-foreground"] = "#555555";
    style["--border"] = "#e5e5e5";
  }
  if (settings.accentColor && /^#[0-9a-fA-F]{3,8}$/.test(settings.accentColor)) {
    style["--primary"] = settings.accentColor;
    style["--accent"] = settings.accentColor;
  }
  if (settings.customCssVars) {
    for (const [k, v] of Object.entries(settings.customCssVars)) {
      if (ALLOWED_CSS_VARS.has(k) && typeof v === "string") {
        style[k] = v;
      }
    }
  }
  return style as CSSProperties;
}

export function StorefrontTheme({
  settings,
  children,
  className = "",
}: {
  settings: StorefrontThemeSettings;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`min-h-screen bg-background text-foreground ${className}`}
      style={buildThemeStyle(settings)}
      data-storefront-theme={settings.themeVariant}
    >
      {children}
    </div>
  );
}
