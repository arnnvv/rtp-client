import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import Hls from "hls.js";

function HLSViewer({
  autoPlay = true,
  muted = true,
  controls = true,
  width = "100%",
  height = "auto",
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

  const hlsUrl = "http://localhost:8080/hls/playlist.m3u8";

  const initializeHLS = () => {
    if (!videoRef.current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setIsLoading(true);
    setError(null);

    if (Hls.isSupported()) {
      console.log("HLS.js is supported. Initializing player.");
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        lowLatencyMode: true,
        backBufferLength: 90,
        enableWorker: true,
        abrEwmaFastLive: 1.0,
        abrEwmaSlowLive: 3.0,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        maxFragLookUpTolerance: 0.25,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingRetryDelay: 1000,
      });

      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("HLS: Manifest parsed successfully.");
        setIsLoading(false);
        setError(null);
        setIsConnected(true);
        if (autoPlay && videoRef.current) {
          videoRef.current.muted = muted;
          videoRef.current.play().catch((err) => {
            console.error("HLS: Autoplay failed:", err);
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
          console.log(
            `HLS: Switched to level ${data.level}: ${level.width}x${level.height} @ ${Math.round(level.bitrate / 1000)} Kbps`,
          );
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        console.error("HLS Error Event:", data);
        if (data.fatal) {
          setError(`HLS Fatal Error: ${data.type} - ${data.details}`);
          setIsConnected(false);
          setIsLoading(false);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log(
                "HLS: Network error detected. Attempting to recover by reloading source...",
              );
              if (hlsRef.current) {
                hlsRef.current.startLoad();
              } else {
                setTimeout(() => initializeHLS(), 3000);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log(
                "HLS: Media error detected. Attempting to recover media error...",
              );
              if (hlsRef.current) {
                hlsRef.current.recoverMediaError();
              } else {
                setTimeout(() => initializeHLS(), 3000);
              }
              break;
            default:
              console.log(
                "HLS: Unhandled fatal error. Destroying and re-initializing HLS player...",
              );
              if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
              }
              setTimeout(() => initializeHLS(), 3000);
              break;
          }
        } else {
          console.warn(`HLS Non-Fatal Error: ${data.type} - ${data.details}`);
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (isLoading) setIsLoading(false);
      });

      hls.on(Hls.Events.DESTROYING, () => {
        console.log("HLS: Instance is being destroyed.");
      });

      console.log("HLS: Loading source:", hlsUrl);
      hls.loadSource(hlsUrl);
      if (videoRef.current) {
        hls.attachMedia(videoRef.current);
      }
    } else if (videoRef.current?.canPlayType("application/vnd.apple.mpegurl")) {
      console.log("HLS: Using native browser HLS support.");
      if (videoRef.current) {
        videoRef.current.src = hlsUrl;
        videoRef.current.muted = muted;
        setIsLoading(false);
        videoRef.current.addEventListener("loadedmetadata", () => {
          console.log("HLS Native: Metadata loaded.");
          setError(null);
          setIsConnected(true);
          if (autoPlay && videoRef.current) {
            videoRef.current.play().catch((err) => {
              console.error("HLS Native: Autoplay failed:", err);
              setError("Autoplay failed. Please click play manually.");
            });
          }
        });
        videoRef.current.addEventListener("error", (e) => {
          console.error("HLS Native: Video playback error:", e);
          setError("Native HLS playback error occurred.");
          setIsConnected(false);
          setIsLoading(false);
        });
      }
    } else {
      console.error(
        "HLS: HLS.js is not supported and no native HLS support in this browser.",
      );
      setError("HLS playback is not supported in this browser.");
      setIsLoading(false);
    }
  };

  const retryConnection = () => {
    console.log("HLS: Manual retry initiated.");
    setError(null);
    setIsLoading(true);
    initializeHLS();
  };

  useEffect(() => {
    initializeHLS();

    return () => {
      if (hlsRef.current) {
        console.log("HLS: Cleaning up HLS instance on component unmount.");
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!videoRef.current) return;
      if (document.hidden) {
        videoRef.current.pause();
        console.log("HLS: Page hidden, video paused.");
      } else if (isConnected && !error && autoPlay) {
        videoRef.current
          .play()
          .catch((err) =>
            console.error("HLS: Resume play on visibility failed:", err),
          );
        console.log("HLS: Page visible, video resumed.");
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isConnected, error, autoPlay]);

  return (
    <div
      style={{ width, height, position: "relative", backgroundColor: "#000" }}
    >
      <video
        ref={videoRef}
        controls={controls}
        muted={muted}
        autoPlay={autoPlay}
        playsInline
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {isLoading && (
        <div style={overlayStyle}>
          Loading live stream...
          {/* {retryCount > 0 && ` (Attempt: ${retryCount}/${maxRetries})`} */}
        </div>
      )}
      {error && (
        <div style={{ ...overlayStyle, color: "red", flexDirection: "column" }}>
          <p>⚠️ {error}</p>
          <button
            onClick={retryConnection}
            style={{ padding: "8px 16px", marginTop: "10px" }}
          >
            Retry Connection
          </button>
        </div>
      )}
      <div style={statusIndicatorStyle}>
        {isConnected ? "● LIVE" : "● OFFLINE"}
      </div>
      {streamInfo && isConnected && (
        <div style={streamInfoStyle}>
          {streamInfo.resolution} @ {streamInfo.bitrate} Kbps (L
          {streamInfo.level})
        </div>
      )}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0,0,0,0.7)",
  color: "white",
  fontSize: "1.2em",
  textAlign: "center",
};

const statusIndicatorStyle: CSSProperties = {
  position: "absolute",
  top: "10px",
  left: "10px",
  padding: "5px 10px",
  backgroundColor: "rgba(0,0,0,0.6)",
  color: "white",
  borderRadius: "4px",
  fontSize: "0.9em",
};

const streamInfoStyle: CSSProperties = {
  position: "absolute",
  bottom: "10px",
  right: "10px",
  padding: "5px 10px",
  backgroundColor: "rgba(0,0,0,0.6)",
  color: "white",
  borderRadius: "4px",
  fontSize: "0.8em",
};

export function HlsComp(): JSX.Element {
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current
        .requestFullscreen()
        .then(() => {
          setFullscreen(true);
        })
        .catch((err) => {
          alert(
            `Error attempting to enable full-screen mode: ${err.message} (${err.name})`,
          );
        });
    } else {
      document.exitFullscreen().then(() => {
        setFullscreen(false);
      });
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
      ref={containerRef}
      style={{
        backgroundColor: "#222",
        padding: fullscreen ? "0" : "20px",
        height: fullscreen ? "100vh" : "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {!fullscreen && (
        <div
          style={{ color: "white", marginBottom: "15px", textAlign: "center" }}
        >
          <h1 style={{ fontSize: "1.5em", marginBottom: "5px" }}>
            📺 Live Video Call Stream
          </h1>
          <p style={{ fontSize: "0.9em" }}>
            Composite view of both participants
          </p>
          <p style={{ fontSize: "0.8em", color: "#aaa" }}>
            Stream URL: http://localhost:8080/hls/playlist.m3u8
          </p>
        </div>
      )}

      <div style={{ width: "100%", maxWidth: "960px", position: "relative" }}>
        {" "}
        {/* Aspect ratio container */}
        <div
          style={{
            paddingTop: "56.25%",
            position: "relative",
            backgroundColor: "black",
          }}
        >
          {" "}
          {/* 16:9 aspect ratio */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
            }}
          >
            <HLSViewer
              autoPlay={true}
              muted={true}
              controls={true}
              width="100%"
              height="100%"
            />
          </div>
        </div>
      </div>

      {!fullscreen && (
        <button
          onClick={toggleFullscreen}
          style={{
            marginTop: "15px",
            padding: "10px 20px",
            fontSize: "1em",
            cursor: "pointer",
          }}
        >
          ⛶ Fullscreen
        </button>
      )}
      {fullscreen && (
        <button
          onClick={toggleFullscreen}
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            zIndex: 1000,
            padding: "10px",
            background: "rgba(0,0,0,0.5)",
            color: "white",
            border: "none",
            cursor: "pointer",
          }}
        >
          Exit Fullscreen
        </button>
      )}
    </div>
  );
}
