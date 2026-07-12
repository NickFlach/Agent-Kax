import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAgentStorefrontSettings,
  useUpdateAgentStorefrontSettings,
  getGetAgentStorefrontSettingsQueryKey,
  getGetAgentStorefrontQueryKey,
  type AgentStorefrontSettings,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StorefrontTheme } from "@/components/storefront-theme";

const SOCIAL_KEYS = ["x", "instagram", "minds", "linkedin", "website"] as const;

export default function StorefrontSettings() {
  const { slug } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const queryKey = getGetAgentStorefrontSettingsQueryKey(slug);
  const { data, isLoading, isError, error } = useGetAgentStorefrontSettings(slug, {
    query: { queryKey, retry: false },
  });

  const [draft, setDraft] = useState<AgentStorefrontSettings | null>(null);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  const updateMutation = useUpdateAgentStorefrontSettings({
    mutation: {
      onSuccess: (saved) => {
        setDraft(saved);
        queryClient.invalidateQueries({ queryKey });
        queryClient.invalidateQueries({ queryKey: getGetAgentStorefrontQueryKey(slug) });
      },
    },
  });

  if (isLoading) return <Skeleton className="h-96" />;
  if (isError || !draft) {
    return (
      <div className="text-center py-16 text-muted-foreground" data-testid="text-settings-error">
        <p className="font-bold">Cannot load storefront settings</p>
        <p className="text-sm mt-1">
          {(error as { message?: string } | null)?.message ?? "You may not own this agent."}
        </p>
        <Link href="/agents" className="text-primary text-sm mt-4 inline-block">
          ← Agents
        </Link>
      </div>
    );
  }

  function setField<K extends keyof AgentStorefrontSettings>(
    key: K,
    value: AgentStorefrontSettings[K],
  ) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function setSocial(key: string, value: string) {
    setDraft((d) => {
      if (!d) return d;
      const next: Record<string, string> = { ...(d.socialLinks ?? {}) };
      if (value.trim()) next[key] = value.trim();
      else delete next[key];
      return { ...d, socialLinks: Object.keys(next).length ? next : null };
    });
  }

  function save() {
    updateMutation.mutate({
      slug,
      data: {
        displayName: draft!.displayName ?? null,
        tagline: draft!.tagline ?? null,
        heroImageUrl: draft!.heroImageUrl ?? null,
        accentColor: draft!.accentColor ?? null,
        themeVariant: draft!.themeVariant,
        socialLinks: draft!.socialLinks ?? null,
        customDomainHint: draft!.customDomainHint ?? null,
        customCssVars: draft!.customCssVars ?? null,
      },
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/agents/${slug}`} className="text-xs text-muted-foreground hover:text-foreground">
            ← Agent
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-1" data-testid="text-page-title">
            Storefront Settings
          </h1>
          <p className="text-muted-foreground mt-1 font-mono text-xs">
            Public URL: <a className="text-primary underline" href={`/s/${slug}`} data-testid="link-public-storefront">/s/{slug}</a>
          </p>
        </div>
        <Button
          onClick={save}
          disabled={updateMutation.isPending}
          data-testid="button-save-storefront"
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Branding
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Display name">
              <Input
                value={draft.displayName ?? ""}
                onChange={(e) => setField("displayName", e.target.value || null)}
                placeholder="e.g. Space Child by Kannaka"
                data-testid="input-display-name"
              />
            </Field>
            <Field label="Tagline">
              <Input
                value={draft.tagline ?? ""}
                onChange={(e) => setField("tagline", e.target.value || null)}
                placeholder="A short tagline for your storefront"
                data-testid="input-tagline"
              />
            </Field>
            <Field label="Hero image URL">
              <Input
                value={draft.heroImageUrl ?? ""}
                onChange={(e) => setField("heroImageUrl", e.target.value || null)}
                placeholder="https://…"
                data-testid="input-hero"
              />
            </Field>
            <Field label="Accent color">
              <div className="flex gap-2">
                <input
                  type="color"
                  value={draft.accentColor ?? "#E8A33D"}
                  onChange={(e) => setField("accentColor", e.target.value)}
                  className="h-9 w-12 bg-transparent border border-border"
                  data-testid="input-accent-color"
                />
                <Input
                  value={draft.accentColor ?? ""}
                  onChange={(e) => setField("accentColor", e.target.value || null)}
                  placeholder="#E8A33D"
                />
              </div>
            </Field>
            <Field label="Theme variant">
              <div className="flex gap-2">
                {(["dark", "light"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setField("themeVariant", v)}
                    className={`px-3 py-1 text-xs uppercase tracking-wider border ${
                      draft.themeVariant === v
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                    data-testid={`button-theme-${v}`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Custom domain hint">
              <Input
                value={draft.customDomainHint ?? ""}
                onChange={(e) => setField("customDomainHint", e.target.value || null)}
                placeholder="e.g. shop.yourbrand.com (DNS not provisioned automatically)"
                data-testid="input-domain-hint"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Social Links
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {SOCIAL_KEYS.map((k) => (
              <Field key={k} label={k}>
                <Input
                  value={(draft.socialLinks?.[k] as string | undefined) ?? ""}
                  onChange={(e) => setSocial(k, e.target.value)}
                  placeholder="https://…"
                  data-testid={`input-social-${k}`}
                />
              </Field>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Custom CSS Variables
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Allowed keys: <code>--background</code>, <code>--foreground</code>, <code>--card</code>,{" "}
            <code>--primary</code>, <code>--accent</code>, <code>--muted</code>, <code>--border</code>,{" "}
            <code>--radius</code>, <code>--font-family</code>. Values longer than 64 chars are dropped.
          </p>
          <CssVarsEditor
            value={draft.customCssVars ?? null}
            onChange={(v) => setField("customCssVars", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
            Live Preview
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <StorefrontTheme settings={draft} className="border border-border">
            <div className="p-8" data-testid="preview-pane">
              {draft.heroImageUrl && (
                <img
                  src={draft.heroImageUrl}
                  alt="hero"
                  className="w-full max-h-48 object-cover mb-6"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
              )}
              <p
                className="text-xs uppercase tracking-[0.3em]"
                style={{ color: "var(--primary)" }}
              >
                {draft.tagline || "Your tagline here"}
              </p>
              <h2 className="text-3xl font-bold mt-2">
                {draft.displayName || `Storefront — @${slug}`}
              </h2>
              <p className="mt-2 text-sm" style={{ color: "var(--muted-foreground)" }}>
                A preview of how visitors will see your storefront. Save to publish.
              </p>
              <div className="mt-4 flex gap-3">
                <span
                  className="px-4 py-2 text-xs uppercase tracking-wider"
                  style={{
                    background: "var(--primary)",
                    color: "var(--primary-foreground, #fff)",
                  }}
                >
                  Browse Drops
                </span>
              </div>
            </div>
          </StorefrontTheme>
        </CardContent>
      </Card>
    </div>
  );
}

const ALLOWED_CSS_VAR_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--accent",
  "--muted",
  "--border",
  "--radius",
  "--font-family",
] as const;

function CssVarsEditor({
  value,
  onChange,
}: {
  value: Record<string, string> | null;
  onChange: (v: Record<string, string> | null) => void;
}) {
  function setVar(key: string, v: string) {
    const next: Record<string, string> = { ...(value ?? {}) };
    if (v.trim()) next[key] = v.trim();
    else delete next[key];
    onChange(Object.keys(next).length ? next : null);
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {ALLOWED_CSS_VAR_KEYS.map((k) => (
        <label key={k} className="block">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            {k}
          </span>
          <Input
            value={value?.[k] ?? ""}
            onChange={(e) => setVar(k, e.target.value)}
            placeholder={k === "--radius" ? "0px" : k === "--font-family" ? "monospace" : "#…"}
            data-testid={`input-cssvar-${k.replace("--", "")}`}
          />
        </label>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
