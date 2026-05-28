import { useState, useEffect, useRef } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { 
  Radar, 
  LayoutDashboard, 
  Bell, 
  Map, 
  Settings, 
  ChevronLeft,
  ChevronRight,
  LogOut,
  Menu,
  X,
  Sun,
  Moon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { alertAPI, getImageUrl, type Alert } from "@/services/api";
import { Badge } from "@/components/ui/badge";
import { SensorChip, TriggerBadge } from "@/lib/sensorIcons";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: Bell, label: "Alerts", path: "/dashboard/alerts" },
  { icon: Map, label: "Live Map", path: "/dashboard/map" },
  { icon: Settings, label: "Settings", path: "/dashboard/settings" },
];

const DashboardLayout = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [recentAlerts, setRecentAlerts] = useState<Alert[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const location = useLocation();
  const { logout, user } = useAuth();

  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark') || 
             (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    return false;
  });

  const toggleTheme = () => {
    const nextIsDark = !isDark;
    setIsDark(nextIsDark);
    if (nextIsDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  useEffect(() => {
    let mounted = true;
    const fetchRecent = async () => {
      try {
        const res = await alertAPI.getAll({ limit: 5 });
        if (!mounted) return;
        setRecentAlerts(res.data || []);
      } catch (e) {
        console.error('Failed to load recent alerts', e);
      }
    };

    fetchRecent();
    const iv = setInterval(fetchRecent, 60000); // poll less frequently (60s)

    const onDocClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotifOpen(false);
    };

    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);

    return () => { mounted = false; clearInterval(iv); document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, []);

  const handleNavClick = () => {
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Mobile Header */}
        <div className="lg:hidden fixed top-0 left-0 right-0 z-50 glass border-b border-border/50">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-3">
            <Radar className="h-7 w-7 text-primary" />
            <span className="text-lg font-bold">
              Project <span className="text-gradient">ORION</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="h-5 w-5 text-muted-foreground" /> : <Moon className="h-5 w-5 text-muted-foreground" />}
            </button>
            <div className="relative">
              <button
                onClick={() => setNotifOpen(!notifOpen)}
                className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
                aria-label="Notifications"
              >
                <Bell className="h-5 w-5 text-muted-foreground" />
                {recentAlerts.filter(a => !a.isVerified).length > 0 && (
                  <Badge className="absolute -top-1 -right-1">{recentAlerts.filter(a => !a.isVerified).length}</Badge>
                )}
              </button>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Overlay */}
      {mobileOpen && (
        <div 
          className="lg:hidden fixed inset-0 bg-background/80 backdrop-blur-sm z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
        className={cn(
          "fixed left-0 top-0 h-screen bg-sidebar border-r border-sidebar-border transition-all duration-300 z-50 flex flex-col",
          // Desktop
          "hidden lg:flex",
          collapsed ? "lg:w-16" : "lg:w-64"
        )}
      >
        {/* Logo */}
        <div className="p-4 border-b border-sidebar-border">
          <Link to="/" className="flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <Radar className="h-8 w-8 text-primary" />
            </div>
            {!collapsed && (
              <span className="text-lg font-bold whitespace-nowrap">
                Project <span className="text-gradient">ORION</span>
              </span>
            )}
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
                  isActive 
                    ? "bg-primary/10 text-primary border border-primary/20" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="h-5 w-5 flex-shrink-0" />
                {!collapsed && <span className="font-medium">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Bottom section */}
        <div className="p-4 border-t border-sidebar-border space-y-2">
          {!collapsed && user && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{user.name}</div>
              <div className="truncate">{user.email}</div>
            </div>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors w-full"
          >
            <LogOut className="h-5 w-5 flex-shrink-0" />
            {!collapsed && <span className="font-medium">Logout</span>}
          </button>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            className="w-full justify-center"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
      </aside>

      {/* Mobile Sidebar */}
      <aside 
        className={cn(
          "lg:hidden fixed left-0 top-0 h-screen w-72 bg-sidebar border-r border-sidebar-border transition-transform duration-300 z-50 flex flex-col pt-16",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={handleNavClick}
                className={cn(
                  "flex items-center gap-3 px-3 py-3 rounded-lg transition-all duration-200",
                  isActive 
                    ? "bg-primary/10 text-primary border border-primary/20" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="h-5 w-5 flex-shrink-0" />
                <span className="font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom section */}
        <div className="p-4 border-t border-sidebar-border">
          {user && (
            <div className="px-3 py-2 mb-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{user.name}</div>
              <div className="truncate">{user.email}</div>
            </div>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-3 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors w-full"
          >
            <LogOut className="h-5 w-5 flex-shrink-0" />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main 
        className={cn(
          "flex-1 min-w-0 overflow-x-hidden transition-all duration-300",
          // Mobile: add top padding for header
          "pt-16 lg:pt-0",
          // Desktop: add left margin for sidebar
          collapsed ? "lg:ml-16" : "lg:ml-64"
        )}
      >
        {/* Desktop topbar (notifications) */}
        <div className="hidden lg:flex items-center justify-end p-4 border-b border-border/40 sticky top-0 z-40 bg-background/80">
          <div className="flex items-center gap-1 mr-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun className="h-5 w-5 text-muted-foreground" /> : <Moon className="h-5 w-5 text-muted-foreground" />}
            </button>
          </div>
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setNotifOpen(!notifOpen)}
              className="p-2 rounded-lg hover:bg-muted/50 transition-colors flex items-center gap-2"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5 text-muted-foreground" />
              {recentAlerts.filter(a => !a.isVerified).length > 0 && (
                <Badge className="ml-1">{recentAlerts.filter(a => !a.isVerified).length}</Badge>
              )}
            </button>

            {notifOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                <div className="p-3 text-sm font-semibold">Recent Alerts</div>
                <div className="divide-y">
                  {recentAlerts.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">No recent alerts</div>
                  ) : (
                    recentAlerts.map((a) => (
                      <Link key={a._id} to="/dashboard/alerts" state={{ alertId: a._id }} className="flex items-center gap-3 p-3 hover:bg-muted/20" onClick={() => setNotifOpen(false)}>
                        <div className="w-12 h-8 bg-background rounded overflow-hidden">
                          {a.imageUrl ? (
                            <img src={getImageUrl(a.imageUrl)} alt="thumb" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-muted/20" />
                          )}
                        </div>
                        <div className="flex-1 text-xs">
                          <div className="flex items-center gap-2">
                            <div className="font-medium truncate">{a.threatType} — {a.sentinelId}</div>
                            {a.triggerType && (
                              <TriggerBadge type={a.triggerType} />
                            )}
                          </div>
                          <div className="text-muted-foreground text-xs">{new Date(a.timestamp).toLocaleString()}</div>
                          {a.triggeredSensors && a.triggeredSensors.length > 0 && (
                            <div className="flex gap-2 mt-2 flex-wrap">
                              {a.triggeredSensors.map((s, i) => (
                                <SensorChip key={i} name={s} />
                              ))}
                            </div>
                          )}
                        </div>
                        {!a.isVerified && <div className="text-warning text-xs">New</div>}
                      </Link>
                    ))
                  )}
                </div>
                <div className="p-2 text-center">
                  <Link to="/dashboard/alerts" className="text-sm text-primary">View all alerts</Link>
                </div>
              </div>
            )}
          </div>
        </div>

        <Outlet />
      </main>
    </div>
  );
};

export default DashboardLayout;
