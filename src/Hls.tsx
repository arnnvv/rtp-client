import { useEffect, useRef, useState, type JSX } from "react";
import Hls from "hls.js";

function HLSViewer({
  autoPlay = true,
  controls = true,
}: {
  autoPlay: boolean;
  controls: boolean;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const hlsUrl = "http://localhost:8080/hls/playlist.m3u8";

  const initializeHLS = () => {
    if (!videoRef.current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setIsLoading(true);
    setError(null);
    setIsConnected(false);

    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        lowLatencyMode: true,
        backBufferLength: 30,
        enableWorker: true,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingRetryDelay: 1000,
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLoading(false);
        setError(null);
        setIsConnected(true);
        if (autoPlay && videoRef.current) {
          videoRef.current.play().catch(() => {
            setError("Autoplay failed or interrupted");
          });
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError(`HLS Fatal error: ${data.type} - ${data.details}`);
          setIsConnected(false);
          setIsLoading(false);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
              ) {
                console.warn(
                  "Manifest load error, retrying HLS initialization...",
                );
                setTimeout(() => initializeHLS(), 3000);
              } else {
                hls.startLoad();
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              console.error(
                "Unhandled HLS fatal error, destroying and re-initializing.",
                data,
              );
              hls.destroy();
              setTimeout(() => initializeHLS(), 5000);
              break;
          }
        } else {
          console.warn(`HLS Non-fatal error: ${data.type} - ${data.details}`);
          if (
            data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT) &&
            hlsRef.current
          ) {
            console.warn(
              "Fragment load error, attempting to recover by starting load.",
            );
            hlsRef.current.startLoad();
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoRef.current);
    } else if (videoRef.current?.canPlayType("application/vnd.apple.mpegurl")) {
      videoRef.current.src = hlsUrl;
      videoRef.current.addEventListener("loadedmetadata", () => {
        setIsLoading(false);
        setIsConnected(true);
        setError(null);
        if (autoPlay) {
          videoRef.current?.play().catch(() => {
            setError("Native HLS autoplay failed");
          });
        }
      });
      videoRef.current.addEventListener("error", () => {
        setError("Native HLS playback error");
        setIsLoading(false);
        setIsConnected(false);
      });
    } else {
      setError("HLS not supported in this browser");
      setIsLoading(false);
    }
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
      if (!videoRef.current) return;
      if (document.hidden) {
        videoRef.current.pause();
      } else if (isConnected && !error && autoPlay) {
        videoRef.current.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isConnected, error, autoPlay]);

  return (
    <div className="p-4 bg-gray-800 text-white rounded-lg shadow-xl">
      <h2 className="text-2xl font-bold mb-3 text-center">
        Composite HLS Stream
      </h2>
      <div className="relative aspect-video bg-black rounded overflow-hidden">
        <video
          ref={videoRef}
          controls={controls}
          autoPlay={autoPlay}
          playsInline
          className="w-full h-full"
          muted={autoPlay}
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-75">
            <p className="text-xl">Loading Stream...</p>
          </div>
        )}
      </div>
      <div className="mt-3 text-center">
        {error && <p className="text-red-500 text-sm">Error: {error}</p>}
        <p>Status: {isConnected ? "LIVE" : "OFFLINE"}</p>
      </div>
      <button onClick={initializeHLS}>Reconnect Stream</button>
    </div>
  );
}

export function HlsComp(): JSX.Element {
  return <HLSViewer autoPlay={true} controls={true} />;
}
