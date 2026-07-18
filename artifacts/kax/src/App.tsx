import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, Link, Redirect, useLocation, useParams } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useGetInboxCounts, getGetInboxCountsQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { PlayerProvider } from "@/contexts/player-context";
import { PersistentPlayer } from "@/components/persistent-player";
import { ConstellationBackdrop } from "@/components/constellation-backdrop";
import { ErrorBoundary } from "@/components/error-boundary";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import ArtifactsList from "@/pages/artifacts-list";
import ArtifactDetail from "@/pages/artifact-detail";
import DropsList from "@/pages/drops-list";
import DropDetail from "@/pages/drop-detail";
import HarvesterPage from "@/pages/harvester";
import Vault from "@/pages/vault";
import AdminUsers from "@/pages/admin-users";
import AdminIntegrations from "@/pages/admin-integrations";
import AgentsList from "@/pages/agents-list";
import AgentDetail from "@/pages/agent-detail";
import StorefrontSettings from "@/pages/storefront-settings";
import AgentStorefront from "@/pages/agent-storefront";
import StoreInterior from "@/pages/store-interior";
import AgentStorefrontDrop from "@/pages/agent-storefront-drop";
import AgentStorefrontArtifact from "@/pages/agent-storefront-artifact";
import Marketplace from "@/pages/marketplace";
import Marketplace3D from "@/pages/marketplace-3d";
import ConstellationAgentPage from "@/pages/constellation-agent";
import Inbox from "@/pages/inbox";
import Proposals from "@/pages/proposals";
import LoginPage from "@/pages/login";
import ResetPasswordPage from "@/pages/reset-password";
import BotsPage from "@/pages/bots";
import FloorPage from "@/pages/floor";
import LandingPage from "@/pages/landing";
import { MobileNav } from "@/components/mobile-nav";
import { CommandPalette } from "@/components/command-palette";

const queryClient = new QueryClient();

function NavLink({ href, children, badge }: { href: string; children: React.ReactNode; badge?: number }) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`relative text-xs uppercase tracking-wider px-3 py-2 transition-colors inline-flex items-center gap-1.5 ${
        isActive ? "text-primary border-b border-primary" : "text-muted-foreground hover:text-foreground"
      }`}
      data-testid={`nav-link-${href.replace(/\//g, "") || "home"}`}
    >
      <span>{children}</span>
      {badge && badge > 0 ? (
        <span
          className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-primary text-primary-foreground"
          data-testid={`nav-badge-${href.replace(/\//g, "") || "home"}`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

interface InboxCountSnapshot {
  proposalsPending: number;
  dmsUnread: number;
}

function useInboxNotifications(enabled: boolean): InboxCountSnapshot {
  const { data } = useGetInboxCounts(undefined, {
    query: {
      queryKey: getGetInboxCountsQueryKey(),
      refetchInterval: enabled ? 30_000 : false,
      enabled,
    },
  });
  const previous = useRef<InboxCountSnapshot | null>(null);
  const proposalsPending = data?.proposalsPending ?? 0;
  const dmsUnread = data?.dmsUnread ?? 0;

  useEffect(() => {
    if (!enabled || !data) return;
    const prev = previous.current;
    if (prev) {
      const dmDelta = dmsUnread - prev.dmsUnread;
      const proposalDelta = proposalsPending - prev.proposalsPending;
      if (proposalDelta > 0) {
        toast({
          title: proposalDelta === 1 ? "New proposal" : `${proposalDelta} new proposals`,
          description: "Open Proposals to review.",
        });
      }
      if (dmDelta > 0) {
        toast({
          title: dmDelta === 1 ? "New DM" : `${dmDelta} new DMs`,
          description: "Open Inbox to read.",
        });
      }
    }
    previous.current = { proposalsPending, dmsUnread };
  }, [enabled, data, proposalsPending, dmsUnread]);

  return { proposalsPending, dmsUnread };
}

function AuthControls() {
  const { user, isLoading, login, logout } = useAuth();
  const [location] = useLocation();
  if (isLoading) return null;
  if (!user) {
    // Suppress on /login itself, and on protected pages where RequireAuth
    // already renders the Connect Wallet CTA — avoid duplicate entry points.
    if (location === "/login") return null;
    return (
      <Button
        size="sm"
        variant="outline"
        className="ml-2 h-7 text-xs uppercase tracking-wider"
        onClick={login}
        data-testid="button-connect-wallet-header"
      >
        Connect Wallet
      </Button>
    );
  }
  const walletShort = user.walletAddress
    ? `${user.walletAddress.slice(0, 6)}…${user.walletAddress.slice(-4)}`
    : null;
  const label = user.displayName || walletShort || user.firstName || user.email || "Account";
  return (
    <div className="flex items-center gap-2 ml-2">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground hidden sm:inline" data-testid="text-current-user">
        {label}
        {user.role === "admin" ? " · admin" : ""}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs uppercase tracking-wider"
        onClick={logout}
        data-testid="button-logout"
      >
        Log out
      </Button>
    </div>
  );
}

function AdminChrome({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { proposalsPending, dmsUnread } = useInboxNotifications(!!user);
  return (
    <div className="min-h-screen bg-background">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:text-xs focus:uppercase focus:tracking-wider"
      >
        Skip to main content
      </a>
      <nav className="border-b border-border sticky top-0 bg-background/95 backdrop-blur-sm z-50" aria-label="Primary">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between h-12">
          <div className="flex items-center gap-2">
            {/* ux-batch1: 13 links overflow small screens — drawer below lg */}
            <div className="lg:hidden">
              <MobileNav
                title="KAX Studio"
                links={[
                  { href: "/dashboard", label: "Dashboard" },
                  { href: "/artifacts", label: "Artifacts" },
                  { href: "/drops", label: "Drops" },
                  { href: "/agents", label: "Agents" },
                  { href: "/bots", label: "Bots" },
                  { href: "/inbox", label: "Inbox", badge: dmsUnread },
                  { href: "/proposals", label: "Proposals", badge: proposalsPending },
                  { href: "/harvester", label: "Harvester" },
                  { href: "/vault", label: "Vault" },
                  ...(isAdmin ? [{ href: "/admin/users", label: "Users" }] : []),
                  { href: "/marketplace", label: "Marketplace" },
                  { href: "/floor", label: "Floor" },
                  { href: "/s/kannaka", label: "Storefront" },
                ]}
              />
            </div>
            <Link href="/" className="font-bold tracking-widest text-sm" data-testid="link-logo">KAX</Link>
          </div>
          <div className="hidden lg:flex items-center gap-1">
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/artifacts">Artifacts</NavLink>
            <NavLink href="/drops">Drops</NavLink>
            <NavLink href="/agents">Agents</NavLink>
            <NavLink href="/bots">Bots</NavLink>
            <NavLink href="/inbox" badge={dmsUnread}>Inbox</NavLink>
            <NavLink href="/proposals" badge={proposalsPending}>Proposals</NavLink>
            <NavLink href="/harvester">Harvester</NavLink>
            <NavLink href="/vault">Vault</NavLink>
            {isAdmin && <NavLink href="/admin/users">Users</NavLink>}
            <div className="w-px h-4 bg-border mx-2" />
            <NavLink href="/marketplace">Marketplace</NavLink>
            <NavLink href="/floor">Floor</NavLink>
            <NavLink href="/s/kannaka">Storefront</NavLink>
            <AuthControls />
          </div>
          <div className="lg:hidden">
            <AuthControls />
          </div>
        </div>
      </nav>
      <CommandPalette />
      <main id="admin-main" className="max-w-7xl mx-auto px-6 py-6 pb-20">
        {children}
      </main>
    </div>
  );
}

function RequireAuth({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();
  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-xs uppercase tracking-widest text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!user) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground uppercase tracking-widest">Wallet sign-in required</p>
        <Button
          onClick={() => {
            const target = `/login?returnTo=${encodeURIComponent(location)}`;
            window.location.href = `${import.meta.env.BASE_URL.replace(/\/+$/, "")}${target}`;
          }}
          data-testid="button-login-gate"
        >
          Connect Wallet
        </Button>
      </div>
    );
  }
  if (adminOnly && user.role !== "admin") {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-muted-foreground uppercase tracking-widest">
        Admin access required
      </div>
    );
  }
  return <>{children}</>;
}

// Routes that share the admin chrome (sticky nav + main container). Rendering
// these inside a single <AdminChrome> wrapper keeps the nav mounted across
// navigations — only the inner <Switch> swaps, so we avoid the chrome flash
// users used to see between pages.
function AdminRoutes() {
  return (
    <AdminChrome>
      <Switch>
        <Route path="/bots">
          <RequireAuth><BotsPage /></RequireAuth>
        </Route>
        <Route path="/dashboard">
          <RequireAuth><Dashboard /></RequireAuth>
        </Route>
        <Route path="/artifacts">
          <RequireAuth><ArtifactsList /></RequireAuth>
        </Route>
        <Route path="/artifacts/:id">
          <RequireAuth><ArtifactDetail /></RequireAuth>
        </Route>
        <Route path="/drops">
          <RequireAuth><DropsList /></RequireAuth>
        </Route>
        <Route path="/drops/:id">
          <RequireAuth><DropDetail /></RequireAuth>
        </Route>
        <Route path="/agents">
          <RequireAuth><AgentsList /></RequireAuth>
        </Route>
        <Route path="/agents/:slug/storefront">
          <RequireAuth><StorefrontSettings /></RequireAuth>
        </Route>
        <Route path="/agents/:slug">
          <RequireAuth><AgentDetail /></RequireAuth>
        </Route>
        <Route path="/inbox">
          <RequireAuth><Inbox /></RequireAuth>
        </Route>
        <Route path="/proposals">
          <RequireAuth><Proposals /></RequireAuth>
        </Route>
        <Route path="/harvester">
          <RequireAuth><HarvesterPage /></RequireAuth>
        </Route>
        <Route path="/vault">
          <RequireAuth><Vault /></RequireAuth>
        </Route>
        <Route path="/admin/users">
          <RequireAuth adminOnly><AdminUsers /></RequireAuth>
        </Route>
        <Route path="/admin/integrations">
          <RequireAuth adminOnly><AdminIntegrations /></RequireAuth>
        </Route>
      </Switch>
    </AdminChrome>
  );
}

const ADMIN_PATHS = [
  "/bots",
  "/dashboard",
  "/artifacts",
  "/drops",
  "/agents",
  "/inbox",
  "/proposals",
  "/harvester",
  "/vault",
  "/admin",
];

function isAdminPath(location: string): boolean {
  return ADMIN_PATHS.some((p) => location === p || location.startsWith(`${p}/`));
}

function Marketplace3DSafe() {
  return (
    <ErrorBoundary
      fallback={(reset) => (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background text-center px-6">
          <p className="text-xs uppercase tracking-[0.3em] text-accent">
            &gt; Render fault in the Market District
          </p>
          <p className="text-sm text-muted-foreground max-w-md">
            Your browser couldn&rsquo;t paint the 3D scene. Try the list view, or reset and try again.
          </p>
          <div className="flex gap-2">
            <Link
              href="/marketplace"
              className="px-4 py-2 text-xs uppercase tracking-wider border border-primary text-primary hover:bg-primary/10"
              data-testid="link-marketplace-fallback-list"
            >
              Open list view
            </Link>
            <button
              onClick={reset}
              className="px-4 py-2 text-xs uppercase tracking-wider border border-accent text-accent hover:bg-accent/10"
              data-testid="button-marketplace-retry"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    >
      <Marketplace3D />
    </ErrorBoundary>
  );
}

function Router() {
  const [location] = useLocation();
  if (isAdminPath(location)) {
    return <AdminRoutes />;
  }
  return (
    <Switch>
      <Route path="/">
        <LandingPage />
      </Route>
      <Route path="/login">
        <LoginPage />
      </Route>
      <Route path="/reset-password">
        <ResetPasswordPage />
      </Route>
      <Route path="/s">
        <Marketplace />
      </Route>
      <Route path="/city">
        <Marketplace3DSafe />
      </Route>
      <Route path="/marketplace">
        <Marketplace />
      </Route>
      <Route path="/floor">
        <FloorPage />
      </Route>
      <Route path="/marketplace/list">
        <Marketplace />
      </Route>
      <Route path="/s/:slug/room">
        <StoreInterior />
      </Route>
      <Route path="/s/:slug">
        <AgentStorefront />
      </Route>
      <Route path="/s/:slug/drops/:id">
        <AgentStorefrontDrop />
      </Route>
      <Route path="/s/:slug/artifacts/:id">
        <AgentStorefrontArtifact />
      </Route>
      <Route path="/constellation/:slug">
        <ConstellationAgentPage />
      </Route>
      <Route path="/storefront">
        <Redirect to="/s/kannaka" />
      </Route>
      <Route path="/storefront/:id">
        <LegacyStorefrontDropRedirect />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function LegacyStorefrontDropRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Redirect to={`/s/kannaka/drops/${id}`} />;
}

function AppCrashFallback({ reset, error }: { reset: () => void; error: Error }) {
  const goHome = () => {
    reset();
    const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
    window.location.href = `${base}/`;
  };
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background text-center px-6"
      data-testid="app-error-boundary"
    >
      <p className="text-xs uppercase tracking-[0.3em] text-primary">
        &gt; Something went wrong
      </p>
      <p className="text-sm text-muted-foreground max-w-md">
        This page hit an unexpected error. You can retry, or head back to the marketplace.
      </p>
      {error?.message ? (
        <p className="text-[11px] font-mono text-muted-foreground/70 max-w-md break-words">
          {error.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="px-4 py-2 text-xs uppercase tracking-wider border border-primary text-primary hover:bg-primary/10"
          data-testid="button-app-error-retry"
        >
          Retry
        </button>
        <button
          onClick={goHome}
          className="px-4 py-2 text-xs uppercase tracking-wider border border-border text-foreground hover:bg-muted"
          data-testid="button-app-error-home"
        >
          Go home
        </button>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlayerProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ConstellationBackdrop />
            <ErrorBoundary
              fallback={(reset, error) => <AppCrashFallback reset={reset} error={error} />}
              onError={(error, info) => {
                console.error("[kax] uncaught render error", error, info.componentStack);
              }}
            >
              <Router />
            </ErrorBoundary>
          </WouterRouter>
          <PersistentPlayer />
        </PlayerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
