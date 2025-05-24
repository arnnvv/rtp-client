import { useEffect, useRef, useState, type JSX } from "react";
import Hls from "hls.js";

function HLSViewer({
  autoPlay = true,
  muted = true,
  controls = true,
  width = "100%",
  height = "100vh",
}: {
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
  width?: string;
  height?: string;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [streamInfo, setStreamInfo] = useState<{
    level: number;
    bitrate: number;
    resolution: string;
  } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 5;

  const hlsUrl = "http://localhost:8080/hls/playlist.m3u8";

  const initializeHLS = () => {
    if (!videoRef.current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 5,
        lowLatencyMode: true,
        backBufferLength: 30,
        enableWorker: true,
        abrEwmaFastLive: 1,
        abrEwmaSlowLive: 3,
        maxStarvationDelay: 1,
        maxLoadingDelay: 2,
        maxFragLookUpTolerance: 0.1,
        fragLoadingTimeOut: 10000,
        manifestLoadingTimeOut: 5000,
      });

      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("HLS: Manifest parsed");
        setIsLoading(false);
        setError(null);
        setIsConnected(true);
        setRetryCount(0);

        if (autoPlay && videoRef.current) {
          videoRef.current.play().catch((err) => {
            console.error("Autoplay failed:", err);
            setError("Autoplay failed. Please click play manually.");
          });
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls.levels[data.level];
        if (level) {
          setStreamInfo({
            level: data.level,
            bitrate: Math.round(level.bitrate / 1000),
            resolution: `${level.width}x${level.height}`,
          });
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        console.error("HLS Error:", data);

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError("Network error. Checking connection...");
              setIsConnected(false);
              if (retryCount < maxRetries) {
                setTimeout(
                  () => {
                    setRetryCount((prev) => prev + 1);
                    hls.startLoad();
                  },
                  2000 * (retryCount + 1),
                );
              } else {
                setError(
                  "Failed to connect after multiple attempts. Please refresh the page.",
                );
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError("Media error. Attempting recovery...");
              hls.recoverMediaError();
              break;
            default:
              setError("Fatal error occurred. Please refresh the page.");
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        setIsLoading(false);
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoRef.current);
    } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
      console.log("Using native HLS support");
      videoRef.current.src = hlsUrl;
      setIsLoading(false);
      setIsConnected(true);

      videoRef.current.addEventListener("loadedmetadata", () => {
        setError(null);
        if (autoPlay) {
          videoRef.current?.play().catch((err) => {
            console.error("Autoplay failed:", err);
            setError("Autoplay failed. Please click play manually.");
          });
        }
      });

      videoRef.current.addEventListener("error", (e) => {
        setError("Video playback error occurred.");
        setIsConnected(false);
        console.error("Video error:", e);
      });
    } else {
      setError("HLS is not supported in this browser.");
      setIsLoading(false);
    }
  };

  const retryConnection = () => {
    setError(null);
    setIsLoading(true);
    setRetryCount(0);
    initializeHLS();
  };

  useEffect(() => {
    initializeHLS();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (videoRef.current) {
        if (document.hidden) {
          videoRef.current.pause();
        } else if (isConnected && !error) {
          videoRef.current.play().catch(console.error);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isConnected, error]);

  return (
    <div
      style={{ width, height, backgroundColor: "#000", position: "relative" }}
    >
      <video
        ref={videoRef}
        controls={controls}
        muted={muted}
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />

      {isLoading && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            color: "white",
            fontSize: "18px",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div style={{ marginBottom: "10px" }}>🔄</div>
            <div>Loading live stream...</div>
            {retryCount > 0 && (
              <div style={{ fontSize: "14px", marginTop: "5px" }}>
                Retry attempt: {retryCount}/{maxRetries}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.9)",
            color: "white",
            fontSize: "16px",
          }}
        >
          <div
            style={{ textAlign: "center", maxWidth: "400px", padding: "20px" }}
          >
            <div style={{ marginBottom: "15px", fontSize: "24px" }}>⚠️</div>
            <div style={{ marginBottom: "15px" }}>{error}</div>
            <button
              onClick={retryConnection}
              style={{
                padding: "10px 20px",
                backgroundColor: "#007bff",
                color: "white",
                border: "none",
                borderRadius: "5px",
                cursor: "pointer",
                fontSize: "14px",
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.backgroundColor = "#0056b3")
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.backgroundColor = "#007bff")
              }
            >
              Retry Connection
            </button>
          </div>
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          background: "rgba(0, 0, 0, 0.7)",
          color: "white",
          padding: "8px 12px",
          borderRadius: "15px",
          fontSize: "12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: isConnected ? "#4CAF50" : "#f44336",
          }}
        />
        <span>{isConnected ? "LIVE" : "OFFLINE"}</span>
      </div>

      {streamInfo && isConnected && (
        <div
          style={{
            position: "absolute",
            bottom: "10px",
            left: "10px",
            background: "rgba(0, 0, 0, 0.7)",
            color: "white",
            padding: "8px 12px",
            borderRadius: "5px",
            fontSize: "12px",
          }}
        >
          <div>Quality: {streamInfo.resolution}</div>
          <div>Bitrate: {streamInfo.bitrate} Kbps</div>
        </div>
      )}
    </div>
  );
}

export function HlsComp(): JSX.Element {
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#000",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!fullscreen && (
        <div
          style={{
            backgroundColor: "#1a1a1a",
            color: "white",
            padding: "15px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "24px" }}>
            📺 Live Video Call Stream
          </h1>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <span style={{ fontSize: "14px", color: "#ccc" }}>
              Composite view of both participants
            </span>
            <button
              onClick={toggleFullscreen}
              style={{
                padding: "8px 16px",
                backgroundColor: "#007bff",
                color: "white",
                border: "none",
                borderRadius: "5px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              ⛶ Fullscreen
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: 1 }}>
        <HLSViewer
          autoPlay={true}
          muted={true}
          controls={true}
          width="100%"
          height={fullscreen ? "100vh" : "calc(100vh - 70px)"}
        />
      </div>

      {!fullscreen && (
        <div
          style={{
            backgroundColor: "#1a1a1a",
            color: "#ccc",
            padding: "10px 20px",
            textAlign: "center",
            fontSize: "12px",
          }}
        >
          <p style={{ margin: 0 }}>
            🔴 Live stream showing both participants side-by-side • Low latency
            HLS streaming • Stream URL: http://localhost:8080/hls/playlist.m3u8
          </p>
        </div>
      )}
    </div>
  );
}
