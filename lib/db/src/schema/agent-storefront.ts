import { pgTable, integer, text, jsonb, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";

export const themeVariantEnum = pgEnum("storefront_theme_variant", ["dark", "light"]);

export const agentStorefrontSettingsTable = pgTable("agent_storefront_settings", {
  agentId: integer("agent_id")
    .primaryKey()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  tagline: text("tagline"),
  heroImageUrl: text("hero_image_url"),
  accentColor: text("accent_color"),
  themeVariant: themeVariantEnum("theme_variant").notNull().default("dark"),
  socialLinks: jsonb("social_links").$type<Record<string, string> | null>(),
  customDomainHint: text("custom_domain_hint"),
  customCssVars: jsonb("custom_css_vars").$type<Record<string, string> | null>(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AgentStorefrontSettings = typeof agentStorefrontSettingsTable.$inferSelect;
export type InsertAgentStorefrontSettings = typeof agentStorefrontSettingsTable.$inferInsert;
