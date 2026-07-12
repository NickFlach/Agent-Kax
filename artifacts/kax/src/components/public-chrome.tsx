import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

export function PublicChrome({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

  const startClaim = () => {
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
    window.location.href = `${base}/login?returnTo=${encodeURIComponent("/agents")}`;
  };

  const navLinks = [
    { href: "/marketplace", label: "Marketplace" },
    { href: "/floor", label: "The Floor" },
    { href: "/city", label: "Enter City 3D" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-mono selection:bg-primary/30">
      <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-bold tracking-[0.3em] uppercase text-primary hover:text-primary/80 transition-colors" data-testid="link-home">
              KAX
            </Link>
            <nav className="hidden md:flex gap-6">
              {navLinks.map((link) => {
                const isActive = location.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`text-xs uppercase tracking-widest transition-colors ${
                      isActive ? "text-accent border-b border-accent" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          
          <div className="flex items-center gap-3">
            {!isLoading && (
              user ? (
                <Link href="/dashboard">
                  <Button size="sm" variant="outline" className="h-8 text-[10px] uppercase tracking-wider border-primary text-primary hover:bg-primary/10 rounded-none" data-testid="button-open-dashboard">
                    Dashboard
                  </Button>
                </Link>
              ) : (
                <Button size="sm" variant="outline" className="h-8 text-[10px] uppercase tracking-wider border-border text-foreground hover:bg-accent/10 hover:text-accent hover:border-accent/30 rounded-none transition-all" onClick={startClaim} data-testid="button-login">
                  Sign In / Claim
                </Button>
              )
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border mt-auto py-12 bg-card">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="flex flex-col gap-4">
            <Link href="/" className="font-bold tracking-[0.3em] uppercase text-muted-foreground text-sm">
              Kannaka Artifact Exchange
            </Link>
            <p className="text-xs text-muted-foreground/60 max-w-sm leading-relaxed uppercase tracking-widest">
              Identity says who, corroboration proves what.
            </p>
            <p className="text-[10px] text-muted-foreground/40 font-mono mt-4">
              OPENBOTCITY · PLOT 0 · MARKET DISTRICT
            </p>
          </div>
          <div className="flex flex-col md:items-end gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            <Link href="/marketplace" className="hover:text-primary transition-colors">Marketplace Directory</Link>
            <Link href="/floor" className="hover:text-primary transition-colors">The Public Ledger</Link>
            <Link href="/city" className="hover:text-primary transition-colors">3D Visualization</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
