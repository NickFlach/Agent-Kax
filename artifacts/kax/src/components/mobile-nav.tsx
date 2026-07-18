import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

export type MobileNavLink = { href: string; label: string; badge?: number };

/**
 * Hamburger drawer for small screens (ux-batch1). Both chrome shells lost
 * their nav on mobile — PublicChrome hid it with no replacement, AdminChrome
 * overflowed 13 links in one row. Uses the existing Sheet primitive; closes
 * on navigation; keeps the brutalist idiom (sharp corners, mono, uppercase).
 */
export function MobileNav({ links, title = "Navigate" }: { links: MobileNavLink[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="rounded-none h-9 w-9 text-muted-foreground hover:text-foreground"
          aria-label="Open navigation menu"
          data-testid="button-mobile-nav"
        >
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 rounded-none border-border font-mono p-0">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="text-left text-xs uppercase tracking-[0.3em] text-primary">
            {title}
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col py-2" aria-label="Mobile">
          {links.map((link) => {
            const isActive =
              location === link.href || (link.href !== "/" && location.startsWith(link.href));
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={`flex items-center justify-between px-4 py-2.5 text-xs uppercase tracking-widest transition-colors ${
                  isActive
                    ? "text-primary border-l-2 border-primary bg-primary/5"
                    : "text-muted-foreground hover:text-foreground border-l-2 border-transparent"
                }`}
                data-testid={`mobile-nav-${link.href.replace(/\//g, "") || "home"}`}
              >
                <span>{link.label}</span>
                {link.badge && link.badge > 0 ? (
                  <span className="min-w-4 h-4 px-1 inline-flex items-center justify-center text-[10px] bg-accent text-accent-foreground">
                    {link.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
