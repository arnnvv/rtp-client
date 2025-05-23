import { useEffect, useRef, useState, type JSX, type RefObject } from "react";
import type { DirectSignalPayload, SignalingMessage } from "./../types";
import { v4 } from "./../uuid";

const WS_URL_BASE = "ws://localhost:8080/ws/stream";

export function App(): JSX.Element {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const originalStream = useRef<MediaStream | null>(null);
  const [clientId] = useState<string>(() => v4());
  const ws = useRef<WebSocket | null>(null);
  const [isWsConnected, setIsWsConnected] = useState(false);

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

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement | null>>(
    new Map(),
  );

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
    pc.onicecandidate = () => {};
    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      ) {
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
      setDisplayedRemoteStreams((prev) => new Map(prev).set(peerId, stream));
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
        case "answer":
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
        case "candidate":
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
        video: { displaySurface: "monitor" },
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
      const existingSender = sendersMap.current.get(track.kind);
      if (existingSender) {
        await existingSender.replaceTrack(track);
      } else {
        const newSender = pc.addTrack(track, newStream);
        sendersMap.current.set(track.kind, newSender);
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
        if (sPC.signalingState === "stable") {
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

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">
        Stream Page (My ID: {clientId.substring(0, 8)})
      </h1>
      <div className="flex gap-4 mb-4">
        {!localStream ? (
          <button
            type="button"
            onClick={startStreaming}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
          >
            Start Camera & Mic
          </button>
        ) : (
          <div className="flex gap-2">
            <p className="text-green-600 py-2">Streaming active.</p>
            {!isScreenSharing ? (
              <button
                type="button"
                onClick={startScreenSharing}
                className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded"
              >
                Share Screen
              </button>
            ) : (
              <button
                type="button"
                onClick={stopScreenSharing}
                className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded"
              >
                Stop Screen Share
              </button>
            )}
          </div>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-2">
        WebSocket: {isWsConnected ? "Connected" : "Disconnected"}
        {isScreenSharing && (
          <span className="ml-4 text-purple-600">🔴 Screen Sharing</span>
        )}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <h2 className="text-xl">
            Your Video ({clientId.substring(0, 8)})
            {isScreenSharing && (
              <span className="text-purple-500 ml-2">[Screen]</span>
            )}
          </h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full bg-gray-800 rounded aspect-video"
            style={{ maxHeight: "400px" }}
          />
        </div>
        {Array.from(displayedRemoteStreams.entries()).map(
          ([peerId, stream]) => (
            <div key={peerId}>
              <h2 className="text-xl">
                Remote Stream from {peerId.substring(0, 8)}
              </h2>
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
                style={{ maxHeight: "400px" }}
                controls
              />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
