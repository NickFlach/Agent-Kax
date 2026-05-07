import { useEffect } from "react";

export interface StorefrontSeoOptions {
  title: string;
  description: string;
  image?: string | null;
  accentColor?: string | null;
  initial?: string;
  jsonLd?: Record<string, unknown>;
}

export function useStorefrontSeo(opts: StorefrontSeoOptions | null) {
  useEffect(() => {
    if (!opts) return;
    const { title, description, image, accentColor, initial, jsonLd } = opts;
    document.title = title;
    setMeta("description", description, "name");
    setMeta("og:title", title);
    setMeta("og:description", description);
    if (image) setMeta("og:image", image);
    setFavicon(initial ?? (title.charAt(0) || "K"), accentColor ?? "#7C3AED");
    if (jsonLd) setLdJson(jsonLd);
  }, [opts]);
}

function setMeta(key: string, content: string, attr: "name" | "property" = "property") {
  const sel = `meta[${attr}="${key}"]`;
  let el = document.querySelector(sel);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLdJson(data: Record<string, unknown>) {
  let el = document.querySelector('script[type="application/ld+json"][data-storefront]');
  if (!el) {
    el = document.createElement("script");
    el.setAttribute("type", "application/ld+json");
    el.setAttribute("data-storefront", "true");
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

function setFavicon(letter: string, accent: string) {
  const safeLetter = (letter || "K").charAt(0).toUpperCase();
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : "#7C3AED";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${safeAccent}"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-weight="bold" font-size="42" fill="#000">${escapeXml(safeLetter)}</text></svg>`;
  const href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  document.querySelectorAll('link[rel~="icon"][data-storefront]').forEach((n) => n.remove());
  const link = document.createElement("link");
  link.setAttribute("rel", "icon");
  link.setAttribute("type", "image/svg+xml");
  link.setAttribute("data-storefront", "true");
  link.setAttribute("href", href);
  document.head.appendChild(link);
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}
