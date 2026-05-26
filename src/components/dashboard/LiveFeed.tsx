import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { VideoOff, Signal, WifiOff, X, AlertCircle, Moon, Camera, Maximize, RefreshCw, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getStreamUrl, sentinelAPI, alertAPI, type Sentinel } from "@/services/api";

interface LiveFeedProps {
  sentinel: Sentinel | null;
  onClose?: () => void;
  onStreamStateChange?: (isActive: boolean) => void;
  externalManualRequest?: boolean;
}

// Keep-alive interval (60 seconds as per Pi documentation)
const KEEPALIVE_INTERVAL = 60000;

const LiveFeed = ({ sentinel, onClose, onStreamStateChange, externalManualRequest }: LiveFeedProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageError, setImageError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [manualStreamRequested, setManualStreamRequested] = useState(false);
  const isManualRequested = externalManualRequest ?? manualStreamRequested;
  const [isActivating, setIsActivating] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [showThreatOverlay, setShowThreatOverlay] = useState(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const keepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const activatedSentinelRef = useRef<string | null>(null);
  // track user-stopped sentinel to avoid auto-reactivation
  const userStoppedDeviceRef = useRef<string | null>(null);
  const navigate = useNavigate();

  // Toggle fullscreen
  const handleFullscreen = () => {
    if (containerRef.current) {
      if (!document.fullscreenElement) {
        containerRef.current.requestFullscreen().catch((err) => {
          console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    }
  };

  // Cleanup function for timers
  const cleanupTimers = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
  }, []);

  // Start keep-alive interval
  const startKeepAlive = useCallback((deviceId: string) => {
    // Clear any existing keep-alive interval
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
    }
    
    console.log(`💓 Starting keep-alive for ${deviceId} (every ${KEEPALIVE_INTERVAL / 1000}s)`);
    
    keepAliveIntervalRef.current = setInterval(async () => {
      try {
        await sentinelAPI.keepAlive(deviceId);
        console.log(`💓 Keep-alive sent to ${deviceId}`);
      } catch (error) {
        console.error(`❌ Keep-alive failed for ${deviceId}:`, error);
      }
    }, KEEPALIVE_INTERVAL);
  }, []);

  // Stop keep-alive interval
  const stopKeepAlive = useCallback(() => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
      console.log('💓 Keep-alive stopped');
    }
  }, []);

  // Activate sentinel for streaming (enter INTRUDER mode)
  const activateSentinel = useCallback(async (deviceId: string): Promise<boolean> => {
    console.log(`🟢 Activating sentinel ${deviceId}...`);
    setIsActivating(true);
    
    try {
      const response = await sentinelAPI.activate(deviceId);
      if (response.success) {
        console.log(`✅ Sentinel ${deviceId} activated - Mode: ${response.data?.mode}`);
        activatedSentinelRef.current = deviceId;
        startKeepAlive(deviceId);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ Failed to activate sentinel ${deviceId}:`, error);
      return false;
    } finally {
      setIsActivating(false);
    }
  }, [startKeepAlive]);

  // Deactivate sentinel (return to SENTRY mode)
  const deactivateSentinel = useCallback(async (deviceId: string): Promise<void> => {
    console.log(`🔴 Deactivating sentinel ${deviceId}...`);
    setIsDeactivating(true);
    stopKeepAlive();
    
    try {
      await sentinelAPI.deactivate(deviceId);
      console.log(`✅ Sentinel ${deviceId} deactivated`);
    } catch (error) {
      console.error(`❌ Failed to deactivate sentinel ${deviceId}:`, error);
      // Don't throw - just log the error. The Pi will auto-deactivate after timeout anyway.
    } finally {
      setIsDeactivating(false);
      activatedSentinelRef.current = null;
    }
  }, [stopKeepAlive]);

  // Reconnect with exponential backoff
  const attemptReconnect = () => {
    if (!sentinel) return;

    cleanupTimers();
    setIsReconnecting(true);

    // Calculate exponential backoff delay (max 30 seconds)
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    console.log(`🔄 Attempting reconnect in ${delay}ms (attempt ${retryCount + 1})`);

    retryTimeoutRef.current = setTimeout(() => {
      console.log('🔄 Reconnecting stream...');
      setImageError(false);
      setImageLoaded(false);
      setRetryCount(prev => prev + 1);
      
      // Force URL refresh by appending timestamp
      const url = getStreamUrl(sentinel);
      if (url) {
        const separator = url.includes('?') ? '&' : '?';
        setStreamUrl(`${url}${separator}_t=${Date.now()}`);
      }
      
      setIsReconnecting(false);
    }, delay);
  };

  // Manual reconnect
  const handleManualReconnect = () => {
    console.log('🔄 Manual reconnect triggered');
    setRetryCount(0); // Reset retry count for fresh start
    setImageError(false);
    setImageLoaded(false);
    setIsReconnecting(false);
    
    if (sentinel) {
      const url = getStreamUrl(sentinel);
      if (url) {
        const separator = url.includes('?') ? '&' : '?';
        setStreamUrl(`${url}${separator}_t=${Date.now()}`);
      }
    }
  };

  // Request stream for inactive sentinel
  const handleRequestStream = async () => {
    if (!sentinel) return;

    console.log('📹 Manual stream request for sentinel', sentinel.deviceId);
    setManualStreamRequested(true);
    setImageError(false);
    setImageLoaded(false);
    setRetryCount(0);

    // Clear any user-stop flag since user explicitly requested
    if (userStoppedDeviceRef.current === sentinel.deviceId) userStoppedDeviceRef.current = null;

    try {
      // Ask backend to request the stream from the device (backend will call the Pi)
      const res = await sentinelAPI.requestStream(sentinel.deviceId);

      if (res && res.success && res.data?.streamUrl) {
        // Backend returned a stream URL immediately
        const proxied = getStreamUrl({ ...sentinel, streamUrl: res.data.streamUrl } as Sentinel);
        setStreamUrl(proxied);
        activatedSentinelRef.current = sentinel.deviceId;
        startKeepAlive(sentinel.deviceId);
        setManualStreamRequested(false);
        return;
      }

      // Otherwise poll the sentinel record until streamUrl appears (avoid tight loops)
      const start = Date.now();
      const timeout = 30000; // 30s max
      const pollInterval = 2000;

      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
        try {
          const sresp = await sentinelAPI.getById(sentinel.deviceId);
          if (sresp && sresp.success && sresp.data?.streamUrl) {
            const url = sresp.data.streamUrl as string;
            const proxied = getStreamUrl({ ...sentinel, streamUrl: url } as Sentinel);
            setStreamUrl(proxied);
            activatedSentinelRef.current = sentinel.deviceId;
            startKeepAlive(sentinel.deviceId);
            setManualStreamRequested(false);
            return;
          }
        } catch (err) {
          console.warn('Polling sentinel for streamUrl failed', err);
        }
      }

      console.error('Timed out waiting for streamUrl from sentinel');
      setManualStreamRequested(false);
    } catch (error) {
      console.error('❌ Failed to request stream:', error);
      setManualStreamRequested(false);
    }
  };

  // Stop manually requested stream
  const handleStopStream = async () => {
    console.log('🛑 Stopping stream');
    
    if (sentinel && activatedSentinelRef.current === sentinel.deviceId) {
      await deactivateSentinel(sentinel.deviceId);
    }
    
    setManualStreamRequested(false);
    setStreamUrl(null);
    setImageError(false);
    setImageLoaded(false);
    cleanupTimers();
    // mark that user intentionally stopped this sentinel to avoid auto-restart
    if (sentinel) userStoppedDeviceRef.current = sentinel.deviceId;
    // Notify parent that stream is inactive
    if (onStreamStateChange) {
      onStreamStateChange(false);
    }
  };



  // Update stream URL when sentinel changes
  useEffect(() => {
    const previousSentinel = activatedSentinelRef.current;
    const isSameDevice = sentinel && previousSentinel === sentinel.deviceId;

    // If the same device is re-selected (e.g., new alert for current device)
    // and we already have a stream running, don't reset anything — keep streaming.
    if (isSameDevice && streamUrl && !imageError) {
      console.log(`🔄 Same device ${sentinel.deviceId} re-selected, keeping active stream`);
      // If the sentinel's status is 'alert', clear any user-stop flag so the stream isn't suppressed
      if (sentinel.status === 'alert' && userStoppedDeviceRef.current === sentinel.deviceId) {
        userStoppedDeviceRef.current = null;
      }
      return;
    }

    // Different device or no active stream — do a full reset
    cleanupTimers();
    setImageError(false);
    setImageLoaded(false);
    setRetryCount(0);
    setIsReconnecting(false);
    setManualStreamRequested(false);
    
    // Notify parent that stream is inactive during transition
    if (onStreamStateChange) {
      onStreamStateChange(false);
    }
    
    // If we had a previous sentinel activated, deactivate it
    if (previousSentinel && (!sentinel || previousSentinel !== sentinel.deviceId)) {
      console.log(`🔄 Sentinel changed, deactivating previous: ${previousSentinel}`);
      deactivateSentinel(previousSentinel);
    }
    
    // Only auto-connect using a stored streamUrl if this is an explicit manual request,
    // OR if the sentinel is currently in an active 'alert' state.
    // Otherwise, we shouldn't auto-start just because a stale streamUrl is in the DB.
    const shouldAutoStart = sentinel?.status === 'alert' || isManualRequested;

    // If the incoming sentinel already has a streamUrl (e.g., from an alert event),
    // use it directly instead of requiring a manual "Request Live Feed" click.
    if (sentinel?.streamUrl && shouldAutoStart) {
      // Clear user-stop flag for alert-triggered streams
      if (sentinel.status === 'alert' && userStoppedDeviceRef.current === sentinel.deviceId) {
        userStoppedDeviceRef.current = null;
      }
      // Don't auto-start if the user explicitly stopped this device
      if (userStoppedDeviceRef.current !== sentinel.deviceId) {
        console.log(`📹 Auto-connecting stream for ${sentinel.deviceId} using stored streamUrl`);
        const url = getStreamUrl(sentinel);
        if (url) {
          setStreamUrl(url);
          activatedSentinelRef.current = sentinel.deviceId;
          startKeepAlive(sentinel.deviceId);
        } else {
          setStreamUrl(null);
        }
      } else {
        setStreamUrl(null);
      }
    } else {
      setStreamUrl(null);
    }

    return () => {
      cleanupTimers();
      if (activatedSentinelRef.current) {
        console.log(`🔴 Component unmounting, auto-deactivating sentinel ${activatedSentinelRef.current}...`);
        sentinelAPI.deactivate(activatedSentinelRef.current).catch(err => {
          console.error("Failed to deactivate on unmount:", err);
        });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentinel?.deviceId, sentinel?.status, sentinel?.streamUrl, isManualRequested, deactivateSentinel, cleanupTimers, onStreamStateChange, startKeepAlive]);

  // Determine whether to show threat overlay by fetching the latest alert for this sentinel
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!sentinel) {
        setShowThreatOverlay(false);
        return;
      }

      try {
        const resp = await alertAPI.getAll({ sentinelId: sentinel.deviceId, limit: 1 });
        const latest = resp.data && resp.data.length > 0 ? resp.data[0] : null;
        if (!mounted) return;
        if (latest) {
          const ageMs = Date.now() - new Date(latest.timestamp).getTime();
          setShowThreatOverlay(ageMs < 2 * 60 * 1000);
        } else {
          setShowThreatOverlay(false);
        }
      } catch (err) {
        console.error('Failed to fetch latest alert for threat overlay check', err);
        if (mounted) setShowThreatOverlay(false);
      }
    })();

    return () => { mounted = false; };
  }, [sentinel?.deviceId, sentinel]);

  // Cleanup on unmount - deactivate sentinel
  useEffect(() => {
    return () => {
      cleanupTimers();
      // Deactivate sentinel when component unmounts
      if (activatedSentinelRef.current) {
        console.log(`🔄 Component unmounting, deactivating: ${activatedSentinelRef.current}`);
        sentinelAPI.deactivate(activatedSentinelRef.current).catch(console.error);
      }
    };
  }, [cleanupTimers]);

  // Handle image load error
  const handleImageError = () => {
    console.error(`❌ Stream error for ${sentinel?.deviceId}`);
    setImageError(true);
    setImageLoaded(false);
    
    // Notify parent that stream is inactive
    if (onStreamStateChange) {
      onStreamStateChange(false);
    }
    
    // Don't auto-retry for inactive sentinels unless manually requested
    if (sentinel?.status === 'inactive' && !isManualRequested) {
      console.log('Stream ended for inactive sentinel (expected behavior)');
      setStreamUrl(null);
      return;
    }
    
    // Automatically attempt to reconnect (max 10 attempts)
    if (retryCount < 10) {
      attemptReconnect();
    } else {
      console.error('❌ Max reconnection attempts reached');
      setIsReconnecting(false);
    }
  };

  // Handle image load success
  const handleImageLoad = () => {
    console.log(`✅ Stream connected for ${sentinel?.deviceId}`);
    setImageLoaded(true);
    setImageError(false);
    setRetryCount(0); // Reset retry count on successful connection
    setIsReconnecting(false);
    
    // Notify parent that stream is active
    if (onStreamStateChange) {
      onStreamStateChange(true);
    }
  };

  // Determine what to render
  const renderContent = () => {
    // Case 1: No sentinel selected
    if (!sentinel) {
      return (
        <div className="flex-1 min-h-0 bg-background rounded-lg relative overflow-hidden flex flex-col items-center justify-center border border-border/50">
          <div className="absolute inset-0 bg-gradient-to-br from-secondary/30 to-background" />
          <div className="relative z-10 text-center space-y-4 px-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Camera className="h-8 w-8 text-primary/50" />
            </div>
            <div>
              <h4 className="font-semibold text-lg mb-2">No Device Selected</h4>
              <p className="text-sm text-muted-foreground max-w-sm">
                Click on a sentinel marker on the map to view its live feed
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Case 2: Sentinel is inactive (sleeping/low-power mode) and no manual stream requested
    if (sentinel.status === 'inactive' && !streamUrl) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="w-full max-w-lg bg-background/60 border border-border/50 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex-shrink-0 w-14 h-14 rounded-full bg-muted/10 flex items-center justify-center">
                <Moon className="h-7 w-7 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h4 className="font-semibold text-lg">{sentinel.deviceId}</h4>
                    <p className="text-sm text-muted-foreground">Device in low-power mode</p>
                  </div>
                  <div className="text-sm">
                    <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted/10 text-xs text-muted-foreground">
                      <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                      Standby
                    </span>
                  </div>
                </div>

                <p className="mt-3 text-sm text-muted-foreground">Camera will activate automatically on threat detection. You can request the live feed manually.</p>

                <div className="mt-4 flex items-center gap-3">
                  <Button 
                    onClick={handleRequestStream}
                    disabled={isActivating}
                    className="flex items-center gap-2"
                  >
                    {isActivating ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Activating...
                      </>
                    ) : (
                      <>
                        <Camera className="h-4 w-4" />
                        Request Live Feed
                      </>
                    )}
                  </Button>
                  <Button variant="ghost" onClick={() => navigate('/dashboard/settings')}>Help</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Case 3: Stream connection lost — show subtle non-blocking status with actions
    // NOTE: if the user manually requested a stream (`manualStreamRequested`),
    // show the large active stream container (loading state) instead of the small card.
    if (imageError || (!streamUrl && !isManualRequested)) {
      return (
        <div className="flex-1 min-h-0 bg-background rounded-lg relative overflow-hidden border border-destructive/30">
          {/* subtle background to avoid full-screen takeover */}
          <div className="absolute inset-0 bg-background/60" />

          <div className="relative z-10 w-full h-full flex items-start justify-center p-4">
            <div className="w-full max-w-md bg-background/70 border border-border rounded-lg p-4 flex items-center gap-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
                {isReconnecting ? (
                  <RefreshCw className="h-6 w-6 text-primary animate-spin" />
                ) : (
                  <VideoOff className="h-6 w-6 text-destructive" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-sm">{isReconnecting ? 'Reconnecting...' : 'Feed Unavailable'}</div>
                    <div className="text-xs text-muted-foreground">{isReconnecting ? `Attempting to connect (attempt ${retryCount + 1}/10)` : `No active video stream from ${sentinel.deviceId}`}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleManualReconnect} disabled={isReconnecting}>
                      {isReconnecting ? 'Reconnecting...' : 'Retry'}
                    </Button>
                    {sentinel.status !== 'inactive' && (
                      <Button size="sm" onClick={handleRequestStream} disabled={isReconnecting}>
                        Request Feed
                      </Button>
                    )}
                  </div>
                </div>
                {retryCount >= 10 && (
                  <div className="mt-2 text-xs text-warning">Max reconnection attempts reached</div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Case 4: Active stream (active or alert status)
    return (
      <div ref={containerRef} className="video-stream-container flex-1 min-h-0 bg-background rounded-lg relative overflow-hidden flex items-center justify-center border border-primary/30">
        {/* Loading state */}
        {!imageLoaded && (
          <div className="absolute inset-0 bg-gradient-to-br from-secondary/50 to-background flex items-center justify-center z-10">
            <div className="text-center space-y-3">
              <div className="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin mx-auto" />
              <p className="text-sm text-muted-foreground">
                {isDeactivating ? 'Disconnecting from stream...' : 'Connecting to stream...'}
              </p>
            </div>
          </div>
        )}
        
        {/* Video Stream */}
        <img
          ref={imgRef}
          src={streamUrl || undefined}
          alt={`Live feed from ${sentinel.deviceId}`}
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            imageLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onError={handleImageError}
          onLoad={handleImageLoad}
        />
        
        {/* Stream overlays */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Corner decorations */}
          <div className="absolute top-3 left-3 w-6 h-6 border-l-2 border-t-2 border-primary/50 rounded-tl" />
          <div className="absolute top-3 right-3 w-6 h-6 border-r-2 border-t-2 border-primary/50 rounded-tr" />
          <div className="absolute bottom-3 left-3 w-6 h-6 border-l-2 border-b-2 border-primary/50 rounded-bl" />
          <div className="absolute bottom-3 right-3 w-6 h-6 border-r-2 border-b-2 border-primary/50 rounded-br" />
          
          {/* Scan lines effect (decorative) */}
          <div className="absolute inset-0 opacity-5 pointer-events-none" />
                    {/* Threat overlay */}
                    {showThreatOverlay && (
                      <div className="absolute inset-0 flex items-start justify-center pointer-events-none z-20">
                        <div className="mt-6 bg-destructive/80 text-white px-3 py-1 rounded-md font-bold">THREAT DETECTED</div>
                      </div>
                    )}

                    {/* Small info panel */}
                    {sentinel && (
                      <div className="absolute bottom-3 left-3 z-20 bg-background/80 text-xs p-2 rounded-md border border-border/40">
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <p>Battery: {sentinel.batteryLevel}%</p>
                          <p>Status: {sentinel.status}</p>
                          <p>
                            Location: {Number(sentinel.location?.lat).toFixed(4)}, {Number(sentinel.location?.lng).toFixed(4)}
                          </p>
                          <p>Last seen: {sentinel.lastSeen ? new Date(sentinel.lastSeen).toLocaleString() : 'Unknown'}</p>
                        </div>
                      </div>
                    )}
        </div>
        
        {/* Top Right Controls */}
        <div className="absolute top-4 right-4 z-30 flex items-center gap-2 bg-background/60 backdrop-blur-sm px-2 py-1 rounded-md border border-border/50 shadow-sm">
          {sentinel && streamUrl && !imageError && (
            <>
              <Signal className="h-4 w-4 text-primary animate-pulse" />
              <span className="text-xs text-primary font-bold tracking-wider mr-1">LIVE</span>
            </>
          )}
          {sentinel && onClose && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-6 w-6 p-0 rounded-full hover:bg-destructive/20 hover:text-destructive transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      
      );
      };

  return (
    <div className="flex flex-col h-full w-full">
      {renderContent()}

      {/* Action Buttons */}
      {sentinel && (streamUrl || isManualRequested) && !imageError && (
        <div className="flex gap-2 mt-4">

          <Button 
            variant="outline" 
            size="sm" 
            className="flex-1 gap-2"
            onClick={handleStopStream}
            disabled={isDeactivating}
          >
            <Power className="h-4 w-4" />
            {isDeactivating ? 'Stopping...' : 'Stop Feed'}
          </Button>
          <Button 
            variant="glow" 
            size="sm" 
            className="flex-1"
            onClick={handleFullscreen}
          >
            <Maximize className="mr-2 h-4 w-4" /> Full Screen
          </Button>
        </div>
      )}
    </div>
  );
};

export default LiveFeed;
