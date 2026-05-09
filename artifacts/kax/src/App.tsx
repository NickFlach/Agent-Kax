import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, Link, Redirect, useLocation, useParams } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetInboxCounts, getGetInboxCountsQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { PlayerProvider } from "@/contexts/player-context";
import { PersistentPlayer } from "@/components/persistent-player";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import ArtifactsList from "@/pages/artifacts-list";
import ArtifactDetail from "@/pages/artifact-detail";
import DropsList from "@/pages/drops-list";
import DropDetail from "@/pages/drop-detail";
import HarvesterPage from "@/pages/harvester";
import Vault from "@/pages/vault";
import AdminUsers from "@/pages/admin-users";
import AgentsList from "@/pages/agents-list";
import AgentDetail from "@/pages/agent-detail";
import StorefrontSettings from "@/pages/storefront-settings";
import AgentStorefront from "@/pages/agent-storefront";
import AgentStorefrontDrop from "@/pages/agent-storefront-drop";
import AgentStorefrontArtifact from "@/pages/agent-storefront-artifact";
import Marketplace from "@/pages/marketplace";
import Marketplace3D from "@/pages/marketplace-3d";
import Inbox from "@/pages/inbox";
import Proposals from "@/pages/proposals";

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
  if (isLoading) return null;
  if (!user) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="ml-2 h-7 text-xs uppercase tracking-wider"
        onClick={login}
        data-testid="button-login"
      >
        Log in
      </Button>
    );
  }
  const label = user.displayName || user.firstName || user.email || "Account";
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

function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { proposalsPending, dmsUnread } = useInboxNotifications(!!user);
  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border sticky top-0 bg-background/95 backdrop-blur-sm z-50">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-12">
          <Link href="/" className="font-bold tracking-widest text-sm" data-testid="link-logo">KAX</Link>
          <div className="flex items-center gap-1">
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/artifacts">Artifacts</NavLink>
            <NavLink href="/drops">Drops</NavLink>
            <NavLink href="/agents">Agents</NavLink>
            <NavLink href="/inbox" badge={dmsUnread}>Inbox</NavLink>
            <NavLink href="/proposals" badge={proposalsPending}>Proposals</NavLink>
            <NavLink href="/harvester">Harvester</NavLink>
            <NavLink href="/vault">Vault</NavLink>
            {isAdmin && <NavLink href="/admin/users">Users</NavLink>}
            <div className="w-px h-4 bg-border mx-2" />
            <NavLink href="/marketplace">Marketplace</NavLink>
            <NavLink href="/s/kannaka">Storefront</NavLink>
            <AuthControls />
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-6 py-6 pb-20">
        {children}
      </main>
    </div>
  );
}

function RequireAuth({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, isLoading, login } = useAuth();
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
        <p className="text-sm text-muted-foreground uppercase tracking-widest">Authentication required</p>
        <Button onClick={login} data-testid="button-login-gate">Log in</Button>
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

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Marketplace3D />
      </Route>
      <Route path="/dashboard">
        <AdminLayout><RequireAuth><Dashboard /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/artifacts">
        <AdminLayout><RequireAuth><ArtifactsList /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/artifacts/:id">
        <AdminLayout><RequireAuth><ArtifactDetail /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/drops">
        <AdminLayout><RequireAuth><DropsList /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/drops/:id">
        <AdminLayout><RequireAuth><DropDetail /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/agents">
        <AdminLayout><RequireAuth><AgentsList /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/agents/:slug/storefront">
        <AdminLayout><RequireAuth><StorefrontSettings /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/agents/:slug">
        <AdminLayout><RequireAuth><AgentDetail /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/s">
        <Marketplace />
      </Route>
      <Route path="/marketplace">
        <Marketplace3D />
      </Route>
      <Route path="/marketplace/list">
        <Marketplace />
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
      <Route path="/inbox">
        <AdminLayout><RequireAuth><Inbox /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/proposals">
        <AdminLayout><RequireAuth><Proposals /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/harvester">
        <AdminLayout><RequireAuth><HarvesterPage /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/vault">
        <AdminLayout><RequireAuth><Vault /></RequireAuth></AdminLayout>
      </Route>
      <Route path="/admin/users">
        <AdminLayout><RequireAuth adminOnly><AdminUsers /></RequireAuth></AdminLayout>
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlayerProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <PersistentPlayer />
        </PlayerProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
