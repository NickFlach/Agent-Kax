import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@workspace/replit-auth-web";
import { Toaster } from "@/components/ui/toaster";
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
import Storefront from "@/pages/storefront";
import StorefrontDrop from "@/pages/storefront-drop";
import AdminUsers from "@/pages/admin-users";

const queryClient = new QueryClient();

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`text-xs uppercase tracking-wider px-3 py-2 transition-colors ${
        isActive ? "text-primary border-b border-primary" : "text-muted-foreground hover:text-foreground"
      }`}
      data-testid={`nav-link-${href.replace(/\//g, "") || "home"}`}
    >
      {children}
    </Link>
  );
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
  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border sticky top-0 bg-background/95 backdrop-blur-sm z-50">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-12">
          <Link href="/" className="font-bold tracking-widest text-sm" data-testid="link-logo">KAX</Link>
          <div className="flex items-center gap-1">
            <NavLink href="/">Dashboard</NavLink>
            <NavLink href="/artifacts">Artifacts</NavLink>
            <NavLink href="/drops">Drops</NavLink>
            <NavLink href="/harvester">Harvester</NavLink>
            <NavLink href="/vault">Vault</NavLink>
            {isAdmin && <NavLink href="/admin/users">Users</NavLink>}
            <div className="w-px h-4 bg-border mx-2" />
            <NavLink href="/storefront">Storefront</NavLink>
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
        <Storefront />
      </Route>
      <Route path="/storefront/:id">
        <StorefrontDrop />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
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
