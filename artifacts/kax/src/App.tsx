import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import ArtifactsList from "@/pages/artifacts-list";
import ArtifactDetail from "@/pages/artifact-detail";
import DropsList from "@/pages/drops-list";
import DropDetail from "@/pages/drop-detail";
import HarvesterPage from "@/pages/harvester";
import Storefront from "@/pages/storefront";
import StorefrontDrop from "@/pages/storefront-drop";

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

function AdminLayout({ children }: { children: React.ReactNode }) {
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
            <div className="w-px h-4 bg-border mx-2" />
            <NavLink href="/storefront">Storefront</NavLink>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-6 py-6">
        {children}
      </main>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/">
        <AdminLayout><Dashboard /></AdminLayout>
      </Route>
      <Route path="/artifacts">
        <AdminLayout><ArtifactsList /></AdminLayout>
      </Route>
      <Route path="/artifacts/:id">
        <AdminLayout><ArtifactDetail /></AdminLayout>
      </Route>
      <Route path="/drops">
        <AdminLayout><DropsList /></AdminLayout>
      </Route>
      <Route path="/drops/:id">
        <AdminLayout><DropDetail /></AdminLayout>
      </Route>
      <Route path="/harvester">
        <AdminLayout><HarvesterPage /></AdminLayout>
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
