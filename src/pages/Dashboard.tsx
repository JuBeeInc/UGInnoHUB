import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { sentinelAPI, alertAPI, getStreamUrl, type Sentinel } from "@/services/api";
import { sentinels as dummySentinels } from "@/lib/dummy-data";
import { wsService, type NewAlertEvent, type StartStreamEvent } from "@/services/websocket";
import StatCard from "@/components/dashboard/StatCard";
import MapComponent from "@/components/dashboard/MapComponent";
import LiveFeed from "@/components/dashboard/LiveFeed";
import SentinelsGrid from "@/components/dashboard/SentinelsGrid";
import { Radio, Activity, AlertTriangle, WifiOff, Bell, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const Dashboard = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [sentinels, setSentinels] = useState<Sentinel[]>([]);
  const [selectedSentinel, setSelectedSentinel] = useState<Sentinel | null>(null);
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [manualRequestingDevice, setManualRequestingDevice] = useState<string | null>(null);
  const [focusTrigger, setFocusTrigger] = useState(0);
  const [alertStats, setAlertStats] = useState({
    total: 0,
    last24Hours: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeFeeds, setActiveFeeds] = useState<Sentinel[]>([]);
  const [multiFeedMode] = useState<boolean>(() => {
    return localStorage.getItem('multiFeedMode') === 'true';
  });
  const { toast } = useToast();
  
  // last fetch timestamp to throttle background calls
  const lastFetchRef = useRef<number>(0);

  const isFirstFetchRef = useRef(true);

  // Fetch sentinels from backend
  const fetchSentinels = useCallback(async () => {
    // throttle: avoid backend flooding
    const now = Date.now();
    if (lastFetchRef.current && now - lastFetchRef.current < 5000) {
      // skip if we fetched less than 5s ago
      return;
    }
    try {
      // Don't set loading on poll updates to avoid UI flicker
      // only set loading on initial fetch
      if (isFirstFetchRef.current) setLoading(true);
      setError(null);

      const response = await sentinelAPI.getAll();
      console.log('📡 Fetched sentinels:', response.data?.length);

      if (response.success && response.data) {
        setSentinels(response.data);
        isFirstFetchRef.current = false;

        // If a sentinel was previously selected, update it with new data
        setSelectedSentinel(prev => {
          if (!prev) return null;
          const updatedSelected = response.data.find(
            s => s.deviceId === prev.deviceId
          );
          return updatedSelected || prev;
        });

        // Update active feeds list with latest fetched details
        setActiveFeeds(prev => prev.map(f => {
          const latest = response.data.find(s => s.deviceId === f.deviceId);
          return latest || f;
        }));
      }
    } catch (err) {
      console.error("Failed to fetch sentinels:", err);
      if (isFirstFetchRef.current) {
        setError("Failed to connect to backend. Please check connection.");

        // Dev-friendly fallback so the map still shows markers
        const mapped: Sentinel[] = dummySentinels.map((s) => ({
          _id: s.id,
          deviceId: s.id,
          status: s.status,
          location: s.location,
          batteryLevel: s.battery,
          lastSeen: s.lastSeen,
        }));
        setSentinels(mapped);
      }
    } finally {
      setLoading(false);
      lastFetchRef.current = Date.now();
    }
  }, []);


  // Fetch alert statistics
  const fetchAlertStats = useCallback(async () => {
    try {
      const response = await alertAPI.getStats();
      if (response.success && response.data) {
        setAlertStats({
          total: response.data.total,
          last24Hours: response.data.last24Hours
        });
      }
    } catch (err) {
      console.error("Failed to fetch alert stats:", err);
    }
  }, []);

  // Stop a live feed (used in grid close or stop feed)
  const handleStopFeed = useCallback((s: Sentinel) => {
    setActiveFeeds(prev => prev.filter(f => f.deviceId !== s.deviceId));
    setSelectedSentinel(prev => prev?.deviceId === s.deviceId ? null : prev);
  }, []);

  // Shared handler for requesting a live stream (used by Grid and Map)
  const handleViewStream = useCallback(async (s: Sentinel) => {
    setSelectedSentinel(s);
    setManualRequestingDevice(s.deviceId);

    // Limit active feeds in Multi-Feed Mode
    if (multiFeedMode) {
      const alreadyStreaming = activeFeeds.some(f => f.deviceId === s.deviceId);
      if (!alreadyStreaming && activeFeeds.length >= 4) {
        toast({ 
          title: 'Maximum feeds reached', 
          description: 'Cannot view more than 4 feeds simultaneously to optimize performance.', 
          variant: 'destructive' 
        });
        setManualRequestingDevice(null);
        return;
      }
    }

    try {
      const res = await sentinelAPI.requestStream(s.deviceId);
      if (res && res.success && res.data?.streamUrl) {
        const streamUrl = res.data.streamUrl;
        
        setSelectedSentinel(prev => prev?.deviceId === s.deviceId ? { ...prev, streamUrl } : prev);
        setIsStreamActive(true);

        setActiveFeeds(prev => {
          const newFeed = { ...s, streamUrl };
          if (multiFeedMode) {
            const updated = prev.map(f => f.deviceId === s.deviceId ? { ...f, ...newFeed } : f);
            if (!updated.some(f => f.deviceId === s.deviceId)) {
              updated.push(newFeed);
            }
            return updated;
          } else {
            return [newFeed];
          }
        });

        fetchSentinels();
        toast({ title: 'Stream started', description: `${s.deviceId} stream available` });
      } else if (res && res.success) {
        // Even if URL is not yet ready, add to activeFeeds so LiveFeed is mounted and shows activating/loading
        setActiveFeeds(prev => {
          if (multiFeedMode) {
            if (!prev.some(f => f.deviceId === s.deviceId)) {
              return [...prev, s];
            }
            return prev;
          } else {
            return [s];
          }
        });
        toast({ title: 'Stream requested', description: `Waiting for ${s.deviceId} to publish stream`, variant: 'default' });
      }
    } catch (err) {
      console.error('Failed to request stream:', err);
      toast({ title: 'Stream request failed', description: 'Unable to start stream', variant: 'destructive' });
    } finally {
      setTimeout(() => setManualRequestingDevice(null), 5000);
    }
  }, [fetchSentinels, activeFeeds, multiFeedMode, toast]);

  // Setup WebSocket connection and listeners
  useEffect(() => {
    // Connect to WebSocket
    wsService.connect();
    setWsConnected(wsService.isConnected());

    // Listen for connection status changes and perform fallback polling if disconnected
    const checkConnection = setInterval(() => {
      const isConnected = wsService.isConnected();
      setWsConnected(isConnected);
      
      if (!isConnected) {
        console.log('🔄 WebSocket not connected. Falling back to active polling.');
        fetchSentinels();
        fetchAlertStats();
      }
    }, 15000); // Check and poll fallback every 15 seconds

    // Subscribe to new alert events
    const unsubscribeAlerts = wsService.onNewAlert((data: NewAlertEvent) => {
      console.log('🚨 New alert received:', data);
      
      toast({
        title: "🚨 New Threat Detected!",
        description: `${data.alert.threatType} detected by ${data.alert.sentinelId}`,
        variant: "destructive",
        className: "cursor-pointer hover:bg-red-950/20 dark:hover:bg-red-950/40 transition-colors border-destructive/50",
        onClick: (e) => {
          const target = e.target as HTMLElement;
          if (target.closest('[toast-close]')) return;
          navigate("/dashboard/alerts", { state: { alertId: data.alert._id } });
        }
      });

      // Auto-select the sentinel with the alert immediately using fresh data from event
      // This ensures we have the latest stream URL and status
      if (data.sentinel) {
        console.log('📡 Selecting alerted sentinel with fresh data:', data.sentinel.deviceId);
        setSelectedSentinel(data.sentinel);

        // Sync active feeds with alert event details
        setActiveFeeds(prev => {
          if (multiFeedMode) {
            if (prev.length >= 4 && !prev.some(f => f.deviceId === data.sentinel.deviceId)) {
              return prev; // limit exceeded
            }
            const updated = prev.map(f => f.deviceId === data.sentinel.deviceId ? { ...f, ...data.sentinel } : f);
            if (!updated.some(f => f.deviceId === data.sentinel.deviceId)) {
              updated.push(data.sentinel);
            }
            return updated;
          } else {
            return [data.sentinel];
          }
        });

        // If the sentinel has a streamUrl, auto-start the stream without requiring manual request
        if (data.sentinel.streamUrl) {
          console.log('📹 Auto-starting stream from alert for', data.sentinel.deviceId);
          setManualRequestingDevice(data.sentinel.deviceId);
          setIsStreamActive(true);
          // Clear the requesting flag after a short delay so LiveFeed picks up the URL
          setTimeout(() => setManualRequestingDevice(null), 3000);
        }
      }

      // Refresh data in background (throttled)
      if (!lastFetchRef.current || Date.now() - lastFetchRef.current > 5000) {
        fetchSentinels();
      }
      if (!lastFetchRef.current || Date.now() - lastFetchRef.current > 60000) {
        fetchAlertStats();
      }
    });

    // Subscribe to alert verified events
    const unsubscribeVerified = wsService.onAlertVerified((data) => {
      console.log('✅ Alert verified:', data);
      toast({
        title: "Alert Verified",
        description: `Alert ${data.alertId} has been ${data.isVerified ? 'verified' : 'unverified'}`,
      });
      fetchAlertStats();
    });

    // Subscribe to sentinel status updates (e.g., auto-reset from alert to active)
    const unsubscribeStatusUpdate = wsService.onSentinelStatusUpdate((data) => {
      console.log('🔄 Sentinel status update:', data);
      
      // Update the sentinel in the list
      setSentinels(prev => prev.map(s => 
        s.deviceId === data.deviceId 
          ? { 
              ...s, 
              status: data.status,
              ...(data.batteryLevel !== undefined && { batteryLevel: data.batteryLevel }),
              ...(data.location && { location: data.location }),
              ...(data.triggerType && { triggerType: data.triggerType })
            }
          : s
      ));
      
      // Update selected sentinel if it's the one that changed
      setSelectedSentinel(prev => 
        prev?.deviceId === data.deviceId
          ? { 
              ...prev, 
              status: data.status,
              ...(data.batteryLevel !== undefined && { batteryLevel: data.batteryLevel }),
              ...(data.location && { location: data.location }),
              ...(data.triggerType && { triggerType: data.triggerType })
            }
          : prev
      );

      // Update active feeds list status
      setActiveFeeds(prev => prev.map(f => 
        f.deviceId === data.deviceId 
          ? { 
              ...f, 
              status: data.status,
              ...(data.batteryLevel !== undefined && { batteryLevel: data.batteryLevel }),
              ...(data.location && { location: data.location }),
              ...(data.triggerType && { triggerType: data.triggerType })
            }
          : f
      ));
    });

    // Subscribe to start-stream events (backend sends this when alert has a stored streamUrl)
    const unsubscribeStartStream = wsService.onStartStream((data: StartStreamEvent) => {
      console.log('📹 start-stream received:', data);

      // Update the sentinel's streamUrl in our local list
      setSentinels(prev => prev.map(s =>
        s.deviceId === data.deviceId
          ? { ...s, streamUrl: data.streamUrl }
          : s
      ));

      // If this sentinel is currently selected, update it and auto-start the stream
      setSelectedSentinel(prev => {
        if (prev?.deviceId === data.deviceId) {
          setManualRequestingDevice(data.deviceId);
          setIsStreamActive(true);
          setTimeout(() => setManualRequestingDevice(null), 3000);
          return { ...prev, streamUrl: data.streamUrl };
        }
        return prev;
      });

      // Update active feeds list streamUrl
      setActiveFeeds(prev => prev.map(f => 
        f.deviceId === data.deviceId
          ? { ...f, streamUrl: data.streamUrl }
          : f
      ));
    });

    // Cleanup on unmount
    return () => {
      unsubscribeAlerts();
      unsubscribeVerified();
      unsubscribeStatusUpdate();
      unsubscribeStartStream();
      clearInterval(checkConnection);
    };
  }, [fetchSentinels, fetchAlertStats, multiFeedMode, toast]);

  // Initial data fetch
  useEffect(() => {
    fetchSentinels();
    fetchAlertStats();
  }, [fetchSentinels, fetchAlertStats]);

  // Restore selection when navigated from LiveMap or from previous tab (sessionStorage)
  const hasRestoredSelection = useRef(false);
  const hasRestoredStreamInit = useRef(false);

  useEffect(() => {
    if (sentinels.length === 0 || hasRestoredSelection.current) return;

    const state = location.state as { sentinelId?: string, autoStartStream?: boolean } | null;
    const targetId = state?.sentinelId || sessionStorage.getItem('selectedSentinelId');

    if (targetId) {
      const match = sentinels.find(s => s.deviceId === targetId);
      if (match) {
        setSelectedSentinel(match);
        hasRestoredSelection.current = true;

        // Auto-start stream if navigated from LiveMap with that intent
        if (state?.autoStartStream && !hasRestoredStreamInit.current) {
          hasRestoredStreamInit.current = true;
          handleViewStream(match);
        }

        // clear navigation state so selecting again doesn't retrigger
        if (state?.sentinelId) {
          try {
            navigate(location.pathname, { replace: true, state: {} });
          } catch (e) {
            // ignore
          }
        }
      }
    } else {
      // No target to restore, mark as completed
      hasRestoredSelection.current = true;
    }
  }, [sentinels, location.state, handleViewStream, navigate]);

  // Persist selection for tab switches
  useEffect(() => {
    if (selectedSentinel) {
      sessionStorage.setItem('selectedSentinelId', selectedSentinel.deviceId);
    }
  }, [selectedSentinel]);

  // Calculate stats from fetched data
  const activeSentinels = sentinels.filter(s => s.status === "active" || s.status === "alert").length;
  const inactiveSentinels = sentinels.filter(s => s.status === "inactive").length;
  const alertingSentinels = sentinels.filter(s => s.status === "alert").length;

  return (
    <div className="w-full max-w-full overflow-x-hidden p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Mission Control</h1>
          <p className="text-muted-foreground text-xs md:text-sm">Real-time surveillance network monitoring</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {error && (
            <div className="flex items-center gap-1.5 glass px-3 py-1.5 rounded-lg border border-warning/50">
              <WifiOff className="h-3.5 w-3.5 text-warning" />
              <span className="text-xs font-medium text-warning">Offline Mode</span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchSentinels();
              fetchAlertStats();
            }}
            disabled={loading}
            className="gap-1.5 h-8 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <div className={`flex items-center gap-1.5 glass px-3 py-1.5 rounded-lg h-8 ${wsConnected ? 'border-primary/50' : 'border-muted'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-primary animate-pulse' : 'bg-muted-foreground'}`} />
            <span className="text-xs font-medium">{wsConnected ? 'Live Updates' : 'Polling Mode'}</span>
          </div>
        </div>
      </div>

      {/* Unified Stats Card */}
      <div className="glass rounded-xl p-3 md:p-4 border border-border/50 shadow-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-2">
          {/* Stat 1: Total Sentinels */}
          <div className="flex items-center gap-2.5 p-1 px-2 md:px-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
              <Radio className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[11px] md:text-xs text-muted-foreground font-medium uppercase tracking-wider">Total</p>
              <p className="text-base md:text-lg font-bold tracking-tight">{sentinels.length}</p>
            </div>
          </div>

          {/* Stat 2: Active */}
          <div className="flex items-center gap-2.5 p-1 px-2 md:px-3 border-l border-border/30">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[11px] md:text-xs text-muted-foreground font-medium uppercase tracking-wider">Active</p>
              <p className="text-base md:text-lg font-bold tracking-tight text-emerald-400">{activeSentinels}</p>
            </div>
          </div>

          {/* Stat 3: Inactive */}
          <div className="flex items-center gap-2.5 p-1 px-2 md:px-3 border-t md:border-t-0 md:border-l border-border/30">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 text-muted-foreground">
              <WifiOff className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[11px] md:text-xs text-muted-foreground font-medium uppercase tracking-wider">Inactive</p>
              <p className="text-base md:text-lg font-bold tracking-tight">{inactiveSentinels}</p>
            </div>
          </div>

          {/* Stat 4: Alerts Today */}
          <div className="flex items-center gap-2.5 p-1 px-2 md:px-3 border-t border-l md:border-t-0 border-border/30">
            <div className="w-8 h-8 rounded-lg bg-warning/10 text-warning flex items-center justify-center flex-shrink-0">
              <Bell className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[11px] md:text-xs text-muted-foreground font-medium uppercase tracking-wider">Alerts Today</p>
              <p className="text-base md:text-lg font-bold tracking-tight text-warning">{alertStats.last24Hours}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Sentinels Horizontal List */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Active Devices</h2>
        <SentinelsGrid
          sentinels={sentinels}
          onFocus={(s) => {
            setSelectedSentinel(s);
            setFocusTrigger(f => f + 1);
          }}
          onViewStream={handleViewStream}
        />
      </div>

      {/* Map & Live Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div id="map-container" className="lg:col-span-3 h-[320px] sm:h-[400px] lg:h-[480px]">
          <MapComponent 
            sentinels={sentinels}
            selectedSentinel={selectedSentinel}
            onSentinelSelect={(s) => {
              setSelectedSentinel(s);
              setFocusTrigger(f => f + 1);
            }}
            onStopFeed={() => {
              setSelectedSentinel(null);
              setIsStreamActive(false);
            }}
            onViewLiveFeed={handleViewStream}
            loading={loading}
            isStreamActive={isStreamActive}
            focusTrigger={focusTrigger}
          />
        </div>

        <div id="feed-container" className="lg:col-span-2 h-auto lg:h-[480px] overflow-y-auto pr-1">
          {multiFeedMode ? (
            <div className={`grid gap-4 ${activeFeeds.length > 1 ? 'grid-cols-2' : 'grid-cols-1'} ${activeFeeds.length <= 2 ? 'h-full' : 'h-auto pb-4'}`}>
              {activeFeeds.length === 0 ? (
                <LiveFeed 
                  sentinel={null} 
                  onClose={() => {}}
                />
              ) : (
                activeFeeds.map(s => (
                  <div key={s.deviceId} className="h-full min-h-[220px] max-h-[480px]">
                    <LiveFeed 
                      sentinel={s}
                      externalManualRequest={manualRequestingDevice === s.deviceId}
                      onClose={() => handleStopFeed(s)}
                      onStreamStateChange={(active) => {
                        setIsStreamActive(activeFeeds.some(f => f.streamUrl !== null));
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          ) : (
            <LiveFeed 
              sentinel={selectedSentinel}
              externalManualRequest={manualRequestingDevice === selectedSentinel?.deviceId}
              onClose={() => {
                setSelectedSentinel(null);
                setIsStreamActive(false);
                setActiveFeeds([]);
              }}
              onStreamStateChange={setIsStreamActive}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
