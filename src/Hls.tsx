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

    if (Hls.isSupported()) {
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
        setIsLoading(false);
        setError(null);
        setIsConnected(true);
        if (autoPlay && videoRef.current) {
          videoRef.current.play().catch(() => {
            setError("Autoplay failed");
          });
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError(`Fatal error: ${data.type}`);
          setIsConnected(false);
          setIsLoading(false);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              setTimeout(() => initializeHLS(), 3000);
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoRef.current);
    } else if (videoRef.current?.canPlayType("application/vnd.apple.mpegurl")) {
      videoRef.current.src = hlsUrl;
      videoRef.current.addEventListener("loadedmetadata", () => {
        setIsConnected(true);
        setError(null);
        if (autoPlay) {
          videoRef.current?.play().catch(() => {
            setError("Autoplay failed");
          });
        }
      });
      videoRef.current.addEventListener("error", () => {
        setError("Native HLS playback error");
        setIsConnected(false);
      });
    } else {
      setError("HLS not supported");
      setIsLoading(false);
    }
  };

  useEffect(() => {
    initializeHLS();
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
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
    <>
      <video
        ref={videoRef}
        controls={controls}
        autoPlay={autoPlay}
        playsInline
      />
      {isLoading && <p>Loading...</p>}
      {error && <p>{error}</p>}
      <p>{isConnected ? "LIVE" : "OFFLINE"}</p>
    </>
  );
}

export function HlsComp(): JSX.Element {
  return <HLSViewer autoPlay={true} controls={true} />;
}
