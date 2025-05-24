import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import type {
  DirectSignalPayload,
  SignalingMessage,
  ServerSignalPayload,
} from "./../types";
import { v4 } from "./../uuid";

const WS_URL_BASE = "ws://localhost:8080/ws/stream";

export function App(): JSX.Element {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const originalStream = useRef<MediaStream | null>(null);
  const [clientId] = useState(() => v4());
  const ws = useRef<WebSocket | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [isStreamingToServer, setIsStreamingToServer] = useState(false);
  const serverPc = useRef<RTCPeerConnection | null>(null);
  const serverPcSenders = useRef<Map<string, RTCRtpSender>>(new Map());
  const pendingServerCandidates = useRef<RTCIceCandidateInit[]>([]);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreams = useRef<Map<string, MediaStream>>(new Map());
  const [displayedRemoteStreams, setDisplayedRemoteStreams] = useState<
    Map<string, MediaStream>
  >(new Map());
  const pendingP2PCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map(),
  );
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  const sendSignalingMessage = (message: SignalingMessage) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
    }
  };

  const createServerPeerConnection = (): RTCPeerConnection => {
    if (serverPc.current && serverPc.current.signalingState !== "closed") {
      return serverPc.current;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({
          type: "server-candidate",
          payload: {
            candidate: event.candidate.toJSON(),
          } as ServerSignalPayload,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("Server PC ICE state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "connected") {
        setIsStreamingToServer(true);
      } else if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      ) {
        setIsStreamingToServer(false);
        serverPc.current?.close();
        serverPc.current = null;
        serverPcSenders.current.clear();
        pendingServerCandidates.current = [];
      }
    };

    serverPc.current = pc;
    return pc;
  };

  const createAndSendOfferToServerPc = async () => {
    if (!serverPc.current || serverPc.current.signalingState === "closed") {
      return;
    }

    const offer = await serverPc.current.createOffer();
    await serverPc.current.setLocalDescription(offer);
    sendSignalingMessage({
      type: "server-offer",
      payload: {
        sdp: serverPc.current.localDescription?.toJSON(),
      } as ServerSignalPayload,
    });
  };

  const createP2PConnection = (peerId: string): RTCPeerConnection => {
    if (peerConnections.current.has(peerId)) {
      const p2pconnection = peerConnections.current.get(peerId);
      if (!p2pconnection)
        throw new Error("P2PConnection does not exist but was in map");
      return p2pconnection;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peerConnections.current.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalingMessage({
          type: "direct-candidate",
          payload: {
            candidate: event.candidate.toJSON(),
            toPeerID: peerId,
          } as DirectSignalPayload,
        });
      }
    };

    pc.ontrack = (event) => {
      let stream = remoteStreams.current.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.current.set(peerId, stream);
      }

      stream.addTrack(event.track);
      setDisplayedRemoteStreams((prev) => new Map(prev).set(peerId, stream!));
    };

    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "failed"
      ) {
        peerConnections.current.get(peerId)?.close();
        peerConnections.current.delete(peerId);
        remoteStreams.current.delete(peerId);
        pendingP2PCandidates.current.delete(peerId);
        setDisplayedRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.delete(peerId);
          return newMap;
        });
      }
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        if (!pc.getSenders().find((s) => s.track === track)) {
          pc.addTrack(track, localStream);
        }
      }
    }

    pc.onnegotiationneeded = async () => {
      if (
        pc.signalingState === "stable" &&
        peerConnections.current.has(peerId)
      ) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignalingMessage({
          type: "direct-offer",
          payload: {
            sdp: pc.localDescription?.toJSON(),
            toPeerID: peerId,
          } as DirectSignalPayload,
        });
      }
    };

    return pc;
  };

  const handleInitiateP2P = (fromPeerID: string) => {
    if (fromPeerID === clientId) return;
    if (peerConnections.current.has(fromPeerID)) {
      return;
    }

    const p2pPc = createP2PConnection(fromPeerID);
    if (p2pPc.getSenders().some((sender) => sender.track)) {
      p2pPc
        .createOffer()
        .then((offer) => {
          return p2pPc.setLocalDescription(offer);
        })
        .then(() => {
          if (p2pPc.localDescription) {
            sendSignalingMessage({
              type: "direct-offer",
              payload: {
                sdp: p2pPc.localDescription.toJSON(),
                toPeerID: fromPeerID,
              } as DirectSignalPayload,
            });
          }
        });
    } else {
      p2pPc.onnegotiationneeded = async () => {
        if (p2pPc.signalingState === "stable") {
          const offer = await p2pPc.createOffer();
          await p2pPc.setLocalDescription(offer);
          sendSignalingMessage({
            type: "direct-offer",
            payload: {
              sdp: p2pPc.localDescription?.toJSON(),
              toPeerID: fromPeerID,
            } as DirectSignalPayload,
          });
        }
      };
    }
  };

  const handleDirectOffer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = createP2PConnection(fromPeerID);
    await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));

    const candidates = pendingP2PCandidates.current.get(fromPeerID);
    if (candidates) {
      for (const candidate of candidates) {
        await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingP2PCandidates.current.delete(fromPeerID);
    }

    const answer = await p2pPc.createAnswer();
    await p2pPc.setLocalDescription(answer);
    if (p2pPc.localDescription) {
      sendSignalingMessage({
        type: "direct-answer",
        payload: {
          sdp: p2pPc.localDescription.toJSON(),
          toPeerID: fromPeerID,
        } as DirectSignalPayload,
      });
    }
  };

  const handleDirectAnswer = async (
    fromPeerID: string,
    sdp: RTCSessionDescriptionInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));

      const candidates = pendingP2PCandidates.current.get(fromPeerID);
      if (candidates) {
        for (const candidate of candidates) {
          await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingP2PCandidates.current.delete(fromPeerID);
      }
    }
  };

  const handleDirectCandidate = async (
    fromPeerID: string,
    candidateInit: RTCIceCandidateInit,
  ) => {
    if (fromPeerID === clientId) return;
    const p2pPc = peerConnections.current.get(fromPeerID);
    if (p2pPc) {
      if (p2pPc.remoteDescription && p2pPc.signalingState !== "closed") {
        await p2pPc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } else {
        const peerCandidates =
          pendingP2PCandidates.current.get(fromPeerID) || [];
        peerCandidates.push(candidateInit);
        pendingP2PCandidates.current.set(fromPeerID, peerCandidates);
      }
    }
  };

  useEffect(() => {
    const wsUrlWithClientId = `${WS_URL_BASE}?clientId=${clientId}`;
    const socket = new WebSocket(wsUrlWithClientId);
    ws.current = socket;

    socket.onopen = () => {
      setIsWsConnected(true);
      sendSignalingMessage({
        type: "signal-initiate-p2p",
        payload: { clientId: clientId },
      });
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data as string) as SignalingMessage;

      switch (message.type) {
        case "server-answer":
          if (
            serverPc.current &&
            message.payload.sdp &&
            serverPc.current.signalingState !== "closed"
          ) {
            await serverPc.current.setRemoteDescription(
              new RTCSessionDescription(message.payload.sdp),
            );
            if (pendingServerCandidates.current.length > 0) {
              for (const candidate of pendingServerCandidates.current) {
                await serverPc.current.addIceCandidate(
                  new RTCIceCandidate(candidate),
                );
              }
              pendingServerCandidates.current = [];
            }
          }
          break;

        case "server-candidate":
          if (
            serverPc.current &&
            message.payload.candidate &&
            serverPc.current.signalingState !== "closed"
          ) {
            if (serverPc.current.remoteDescription) {
              await serverPc.current.addIceCandidate(
                new RTCIceCandidate(message.payload.candidate),
              );
            } else {
              pendingServerCandidates.current.push(
                message.payload.candidate as RTCIceCandidateInit,
              );
            }
          }
          break;

        case "signal-initiate-p2p":
          if (
            message.payload.fromPeerID &&
            message.payload.fromPeerID !== clientId
          ) {
            if (!peerConnections.current.has(message.payload.fromPeerID)) {
              handleInitiateP2P(message.payload.fromPeerID);
            }
          }
          break;

        case "direct-offer":
          if (message.payload.fromPeerID && message.payload.sdp) {
            await handleDirectOffer(
              message.payload.fromPeerID,
              message.payload.sdp,
            );
          }
          break;

        case "direct-answer":
          if (message.payload.fromPeerID && message.payload.sdp) {
            await handleDirectAnswer(
              message.payload.fromPeerID,
              message.payload.sdp,
            );
          }
          break;

        case "direct-candidate":
          if (message.payload.fromPeerID && message.payload.candidate) {
            await handleDirectCandidate(
              message.payload.fromPeerID,
              message.payload.candidate,
            );
          }
          break;

        default:
          break;
      }
    };

    socket.onerror = () => {
      setIsWsConnected(false);
    };

    socket.onclose = () => {
      ws.current = null;
      setIsWsConnected(false);
    };

    return () => {
      serverPc.current?.close();
      serverPc.current = null;
      serverPcSenders.current.clear();
      pendingServerCandidates.current = [];

      for (const [, pc] of peerConnections.current) {
        pc.close();
      }
      peerConnections.current.clear();
      remoteStreams.current.clear();
      pendingP2PCandidates.current.clear();
      setDisplayedRemoteStreams(new Map());

      if (ws.current) {
        ws.current.onopen = null;
        ws.current.onmessage = null;
        ws.current.onerror = null;
        ws.current.onclose = null;
        ws.current.close();
      }

      ws.current = null;
      setIsWsConnected(false);
      setIsStreamingToServer(false);

      if (localStream) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        setLocalStream(null);
      }
    };
  }, [clientId]);

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error) {
      alert("Could not access camera/microphone. Please check permissions.");
    }
  };

  const startScreenSharing = async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" as any },
        audio: true,
      });

      originalStream.current = localStream;
      setScreenStream(displayStream);
      setLocalStream(displayStream);
      setIsScreenSharing(true);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = displayStream;
      }

      if (serverPc.current && serverPc.current.signalingState !== "closed") {
        await replaceTracksOnPeerConnection(
          serverPc.current,
          displayStream,
          serverPcSenders,
        );
      }

      for (const [_, p2pPc] of peerConnections.current) {
        if (p2pPc.signalingState !== "closed") {
          await replaceTracksOnP2PConnection(p2pPc, displayStream);
        }
      }

      displayStream.getVideoTracks()[0].onended = () => {
        stopScreenSharing();
      };
    } catch (error) {
      alert("Could not start screen sharing. Please check permissions.");
    }
  };

  const stopScreenSharing = async () => {
    if (!originalStream.current) {
      return;
    }

    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
    }

    setLocalStream(originalStream.current);
    setIsScreenSharing(false);

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = originalStream.current;
    }

    if (serverPc.current && serverPc.current.signalingState !== "closed") {
      await replaceTracksOnPeerConnection(
        serverPc.current,
        originalStream.current,
        serverPcSenders,
      );
    }

    for (const [_, p2pPc] of peerConnections.current) {
      if (p2pPc.signalingState !== "closed") {
        await replaceTracksOnP2PConnection(p2pPc, originalStream.current);
      }
    }

    originalStream.current = null;
  };

  const replaceTracksOnPeerConnection = async (
    pc: RTCPeerConnection,
    newStream: MediaStream,
    sendersMap: RefObject<Map<string, RTCRtpSender>>,
  ) => {
    for (const track of newStream.getTracks()) {
      const existingSender = sendersMap.current?.get(track.kind);
      if (existingSender) {
        await existingSender.replaceTrack(track);
      } else {
        const newSender = pc.addTrack(track, newStream);
        sendersMap.current?.set(track.kind, newSender);
      }
    }
  };

  const replaceTracksOnP2PConnection = async (
    pc: RTCPeerConnection,
    newStream: MediaStream,
  ) => {
    for (const track of newStream.getTracks()) {
      const existingSender = pc
        .getSenders()
        .find((sender) => sender.track?.kind === track.kind);
      if (existingSender) {
        await existingSender.replaceTrack(track);
      } else {
        pc.addTrack(track, newStream);
      }
    }
  };

  useEffect(() => {
    if (localStream && isWsConnected) {
      initiateHLSConnection(localStream);
      initiateP2PConnectionsWithExistingPeers(localStream);
    }
  }, [localStream, isWsConnected]);

  const initiateHLSConnection = async (currentLocalStream: MediaStream) => {
    let sPC = serverPc.current;
    if (!sPC || sPC.signalingState === "closed") {
      sPC = createServerPeerConnection();
    }

    let tracksChangedOrAddedToHLS = false;
    for (const track of currentLocalStream.getTracks()) {
      const existingSender = serverPcSenders.current.get(track.kind);
      if (existingSender) {
        if (existingSender.track?.id !== track.id) {
          await existingSender.replaceTrack(track);
          tracksChangedOrAddedToHLS = true;
        }
      } else {
        const newSender = sPC.addTrack(track, currentLocalStream);
        serverPcSenders.current.set(track.kind, newSender);
        tracksChangedOrAddedToHLS = true;
      }
    }

    if (sPC.signalingState === "stable" && tracksChangedOrAddedToHLS) {
      await createAndSendOfferToServerPc();
    } else if (sPC.signalingState !== "stable") {
      sPC.onnegotiationneeded = async () => {
        if (sPC!.signalingState === "stable") {
          await createAndSendOfferToServerPc();
        }
      };
    }
  };

  const initiateP2PConnectionsWithExistingPeers = (
    currentLocalStream: MediaStream,
  ) => {
    peerConnections.current.forEach(async (p2pPc, peerId) => {
      let p2pTracksChanged = false;
      for (const track of currentLocalStream.getTracks()) {
        const existingSender = p2pPc
          .getSenders()
          .find((s) => s.track?.kind === track.kind);
        if (existingSender) {
          if (
            existingSender.track?.id !== track.id &&
            existingSender.track !== null
          ) {
            await existingSender.replaceTrack(track);
            p2pTracksChanged = true;
          }
        } else {
          p2pPc.addTrack(track, currentLocalStream);
          p2pTracksChanged = true;
        }
      }

      if (p2pTracksChanged && p2pPc.signalingState === "stable") {
        const offer = await p2pPc.createOffer();
        await p2pPc.setLocalDescription(offer);
        sendSignalingMessage({
          type: "direct-offer",
          payload: {
            sdp: p2pPc.localDescription?.toJSON(),
            toPeerID: peerId,
          } as DirectSignalPayload,
        });
      }
    });
  };

  useEffect(() => {
    displayedRemoteStreams.forEach((stream, peerId) => {
      const videoElement = remoteVideoRefs.current.get(peerId);
      if (videoElement && videoElement.srcObject !== stream) {
        videoElement.srcObject = stream;
      }
    });
  }, [displayedRemoteStreams]);

  // Calculate total participants (local + remote)
  const totalParticipants = displayedRemoteStreams.size + 1;
  const isCompositeStreamReady = totalParticipants === 2 && isStreamingToServer;

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-6 text-center">
          Video Call Composite Streaming (Participant:{" "}
          {clientId.substring(0, 8)})
        </h1>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4">Stream Controls</h2>
              {!localStream ? (
                <button
                  onClick={startStreaming}
                  className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
                >
                  Start Camera & Mic
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-green-600 font-medium">
                    ✓ Streaming active
                  </p>
                  {!isScreenSharing ? (
                    <button
                      onClick={startScreenSharing}
                      className="w-full bg-purple-500 text-white px-4 py-2 rounded hover:bg-purple-600"
                    >
                      Share Screen
                    </button>
                  ) : (
                    <button
                      onClick={stopScreenSharing}
                      className="w-full bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
                    >
                      Stop Screen Share
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="bg-white p-4 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-2">Connection Status</h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>WebSocket:</span>
                  <span
                    className={
                      isWsConnected ? "text-green-600" : "text-red-600"
                    }
                  >
                    {isWsConnected ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>HLS Stream:</span>
                  <span
                    className={
                      isStreamingToServer ? "text-green-600" : "text-red-600"
                    }
                  >
                    {isStreamingToServer ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Participants:</span>
                  <span className="font-medium">{totalParticipants}/2</span>
                </div>
                {isCompositeStreamReady && (
                  <div className="text-green-600 font-medium">
                    ✓ Composite stream ready
                  </div>
                )}
              </div>
            </div>

            {isScreenSharing && (
              <div className="bg-purple-100 p-4 rounded-lg">
                <p className="text-purple-800 font-medium">
                  🔴 Screen Sharing Active
                </p>
              </div>
            )}

            {isCompositeStreamReady && (
              <div className="bg-green-100 p-4 rounded-lg">
                <h3 className="font-bold text-green-800 mb-2">
                  Composite HLS Stream Available
                </h3>
                <p className="text-green-700 mb-2">
                  Live stream showing both participants side-by-side:
                </p>
                <code className="block p-2 bg-green-200 rounded text-sm break-all">
                  http://127.0.0.1:8080/hls/playlist.m3u8
                </code>
                <p className="text-sm text-green-600 mt-2">
                  ✓ Both participants connected - Composite stream active
                </p>
              </div>
            )}

            {isStreamingToServer && !isCompositeStreamReady && (
              <div className="bg-yellow-100 p-4 rounded-lg">
                <h3 className="font-bold text-yellow-800 mb-2">
                  Waiting for Second Participant
                </h3>
                <p className="text-yellow-700">
                  Composite HLS stream will start when both participants join
                  the call.
                </p>
                <p className="text-sm text-yellow-600 mt-2">
                  Share your client ID with the other participant: <br />
                  <code className="bg-yellow-200 px-1 rounded">
                    http://127.0.0.1:8080/hls/playlist.m3u8
                  </code>
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="font-medium mb-2">
                Your Video ({clientId.substring(0, 8)})
                {isScreenSharing && (
                  <span className="ml-2 text-purple-600 text-sm">[Screen]</span>
                )}
              </h3>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full bg-gray-700 rounded aspect-video"
                style={{ maxHeight: "300px" }}
              />
            </div>

            {Array.from(displayedRemoteStreams.entries()).map(
              ([peerId, stream]) => (
                <div key={peerId} className="bg-white p-4 rounded-lg shadow">
                  <h3 className="font-medium mb-2">
                    Remote Stream from {peerId.substring(0, 8)}
                  </h3>
                  <video
                    ref={(el) => {
                      if (el) {
                        remoteVideoRefs.current.set(peerId, el);
                        if (el.srcObject !== stream) el.srcObject = stream;
                      } else {
                        remoteVideoRefs.current.delete(peerId);
                      }
                    }}
                    autoPlay
                    playsInline
                    className="w-full bg-gray-700 rounded aspect-video"
                    style={{ maxHeight: "300px" }}
                    controls
                  />
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
