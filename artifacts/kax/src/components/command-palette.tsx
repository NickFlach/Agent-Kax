import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAuth } from "@/hooks/use-auth";

/**
 * Global ⌘K / Ctrl-K palette (ux-batch1). cmdk shipped in the bundle unused;
 * a 25-route app aimed at power users deserves jump-anywhere. Routes only in
 * v1 — entity search (storefronts/artifacts by name) can layer on later.
 */
const PUBLIC_ROUTES = [
  { href: "/", label: "Landing" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/floor", label: "The Floor — deal ledger" },
  { href: "/city", label: "Enter City 3D" },
  { href: "/s/kannaka", label: "Kannaka storefront" },
];

const ADMIN_ROUTES = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/artifacts", label: "Artifacts" },
  { href: "/drops", label: "Drops" },
  { href: "/agents", label: "Agents" },
  { href: "/bots", label: "Bots — OBC & identity" },
  { href: "/inbox", label: "Inbox" },
  { href: "/proposals", label: "Proposals" },
  { href: "/harvester", label: "Harvester" },
  { href: "/vault", label: "Vault — 1 of 1s" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Marketplace">
          {PUBLIC_ROUTES.map((r) => (
            <CommandItem key={r.href} onSelect={() => go(r.href)} value={r.label}>
              {r.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {user ? (
          <CommandGroup heading="Studio">
            {ADMIN_ROUTES.map((r) => (
              <CommandItem key={r.href} onSelect={() => go(r.href)} value={r.label}>
                {r.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
