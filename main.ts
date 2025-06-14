import { v4 } from "./uuid";
import type {
  DirectSignalPayload,
  SignalingMessage,
  ServerSignalPayload,
} from "./types";

let localStream: MediaStream | null = null;
let isScreenSharing = false;
let screenStream: MediaStream | null = null;
let originalStream: MediaStream | null = null;
const clientId = v4();
let ws: WebSocket | null = null;
let isWsConnected = false;
let isStreamingToServer = false;
let serverPc: RTCPeerConnection | null = null;
const serverPcSenders = new Map<string, RTCRtpSender>();
let pendingServerCandidates: RTCIceCandidateInit[] = [];
const peerConnections = new Map<string, RTCPeerConnection>();
const remoteStreams = new Map<string, MediaStream>();
let displayedRemoteStreams = new Map<string, MediaStream>();
const pendingP2PCandidates = new Map<string, RTCIceCandidateInit[]>();

const WS_URL_BASE = "ws://localhost:8080/ws/stream";

let localVideo: HTMLVideoElement;
let remoteVideosContainer: HTMLDivElement;
let startStreamBtn: HTMLButtonElement;
let activeControls: HTMLDivElement;
let shareScreenBtn: HTMLButtonElement;
let stopShareBtn: HTMLButtonElement;
let wsStatusEl: HTMLElement;
let hlsStatusEl: HTMLElement;
let participantsCountEl: HTMLElement;
let screenSharingNotice: HTMLElement;
let compositeReadyStatus: HTMLElement;
let compositeReadyNotice: HTMLElement;
let waitingNotice: HTMLElement;
let clientIdDisplay: HTMLElement;
let localVideoLabel: HTMLElement;
let localVideoScreenLabel: HTMLElement;

function updateUI() {
  wsStatusEl.textContent = isWsConnected ? "Connected" : "Disconnected";
  hlsStatusEl.textContent = isStreamingToServer ? "Active" : "Inactive";

  const totalParticipants = displayedRemoteStreams.size + 1;
  participantsCountEl.textContent = `${totalParticipants}/2`;

  const isCompositeStreamReady = totalParticipants === 2 && isStreamingToServer;

  if (localStream) {
    startStreamBtn.hidden = true;
    activeControls.hidden = false;
    shareScreenBtn.hidden = isScreenSharing;
    stopShareBtn.hidden = !isScreenSharing;
  } else {
    startStreamBtn.hidden = false;
    activeControls.hidden = true;
  }

  screenSharingNotice.hidden = !isScreenSharing;
  localVideoScreenLabel.hidden = !isScreenSharing;
  compositeReadyStatus.hidden = !isCompositeStreamReady;
  compositeReadyNotice.hidden = !isCompositeStreamReady;
  waitingNotice.hidden = !isStreamingToServer || isCompositeStreamReady;
}

function renderRemoteStreams() {
  remoteVideosContainer.innerHTML = "";
  displayedRemoteStreams.forEach((stream, peerId) => {
    const videoContainer = document.createElement("div");

    const title = document.createElement("h3");
    title.textContent = `Remote Stream from ${peerId.substring(0, 8)}`;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.controls = true;
    video.srcObject = stream;

    videoContainer.appendChild(title);
    videoContainer.appendChild(video);
    remoteVideosContainer.appendChild(videoContainer);
  });
  updateUI();
}

const sendSignalingMessage = (message: SignalingMessage) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const createServerPeerConnection = (): RTCPeerConnection => {
  if (serverPc && serverPc.signalingState !== "closed") {
    return serverPc;
  }
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage({
        type: "server-candidate",
        payload: { candidate: event.candidate.toJSON() } as ServerSignalPayload,
      });
    }
  };
  pc.oniceconnectionstatechange = () => {
    console.log("Server PC ICE state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "connected") {
      isStreamingToServer = true;
    } else if (
      ["failed", "closed", "disconnected"].includes(pc.iceConnectionState)
    ) {
      isStreamingToServer = false;
      serverPc?.close();
      serverPc = null;
      serverPcSenders.clear();
      pendingServerCandidates = [];
    }
    updateUI();
  };
  serverPc = pc;
  return pc;
};

const createAndSendOfferToServerPc = async () => {
  if (!serverPc || serverPc.signalingState === "closed") return;
  const offer = await serverPc.createOffer();
  await serverPc.setLocalDescription(offer);
  sendSignalingMessage({
    type: "server-offer",
    payload: {
      sdp: serverPc.localDescription?.toJSON(),
    } as ServerSignalPayload,
  });
};

const createP2PConnection = (peerId: string): RTCPeerConnection => {
  if (peerConnections.has(peerId)) {
    const p2pconnection = peerConnections.get(peerId);
    if (p2pconnection === undefined) {
      throw new Error(" p2pconnection Undefined");
    }
    return p2pconnection;
  }
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peerConnections.set(peerId, pc);
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
    let stream = remoteStreams.get(peerId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreams.set(peerId, stream);
    }
    stream.addTrack(event.track);
    displayedRemoteStreams = new Map(displayedRemoteStreams).set(
      peerId,
      stream,
    );
    renderRemoteStreams();
  };
  pc.oniceconnectionstatechange = () => {
    if (["disconnected", "closed", "failed"].includes(pc.iceConnectionState)) {
      peerConnections.get(peerId)?.close();
      peerConnections.delete(peerId);
      remoteStreams.delete(peerId);
      pendingP2PCandidates.delete(peerId);
      const newMap = new Map(displayedRemoteStreams);
      newMap.delete(peerId);
      displayedRemoteStreams = newMap;
      renderRemoteStreams();
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
    if (pc.signalingState === "stable" && peerConnections.has(peerId)) {
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
  if (fromPeerID === clientId || peerConnections.has(fromPeerID)) return;
  createP2PConnection(fromPeerID);
};

const handleDirectOffer = async (
  fromPeerID: string,
  sdp: RTCSessionDescriptionInit,
) => {
  if (fromPeerID === clientId) return;
  const p2pPc = createP2PConnection(fromPeerID);
  await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
  const candidates = pendingP2PCandidates.get(fromPeerID);
  if (candidates) {
    for (const candidate of candidates) {
      await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    pendingP2PCandidates.delete(fromPeerID);
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
  const p2pPc = peerConnections.get(fromPeerID);
  if (p2pPc) {
    await p2pPc.setRemoteDescription(new RTCSessionDescription(sdp));
    const candidates = pendingP2PCandidates.get(fromPeerID);
    if (candidates) {
      for (const candidate of candidates) {
        await p2pPc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingP2PCandidates.delete(fromPeerID);
    }
  }
};

const handleDirectCandidate = async (
  fromPeerID: string,
  candidateInit: RTCIceCandidateInit,
) => {
  if (fromPeerID === clientId) return;
  const p2pPc = peerConnections.get(fromPeerID);
  if (p2pPc) {
    if (p2pPc.remoteDescription && p2pPc.signalingState !== "closed") {
      await p2pPc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } else {
      const peerCandidates = pendingP2PCandidates.get(fromPeerID) || [];
      peerCandidates.push(candidateInit);
      pendingP2PCandidates.set(fromPeerID, peerCandidates);
    }
  }
};

const initiateHLSConnection = async (currentLocalStream: MediaStream) => {
  const sPC = serverPc || createServerPeerConnection();
  let tracksChangedOrAddedToHLS = false;
  for (const track of currentLocalStream.getTracks()) {
    const existingSender = serverPcSenders.get(track.kind);
    if (existingSender) {
      if (existingSender.track?.id !== track.id) {
        await existingSender.replaceTrack(track);
        tracksChangedOrAddedToHLS = true;
      }
    } else {
      const newSender = sPC.addTrack(track, currentLocalStream);
      serverPcSenders.set(track.kind, newSender);
      tracksChangedOrAddedToHLS = true;
    }
  }
  if (sPC.signalingState === "stable" && tracksChangedOrAddedToHLS) {
    await createAndSendOfferToServerPc();
  } else if (sPC.signalingState !== "stable") {
    sPC.onnegotiationneeded = async () => {
      if (sPC?.signalingState === "stable") {
        await createAndSendOfferToServerPc();
      }
    };
  }
};

const initiateP2PConnectionsWithExistingPeers = (
  currentLocalStream: MediaStream,
) => {
  peerConnections.forEach(async (p2pPc, peerId) => {
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

const startStreaming = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStream = stream;
    localVideo.srcObject = stream;
    if (isWsConnected) {
      initiateHLSConnection(stream);
      initiateP2PConnectionsWithExistingPeers(stream);
    }
  } catch (error) {
    alert("Could not access camera/microphone. Please check permissions.");
  }
  updateUI();
};

const startScreenSharing = async () => {
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor" },
      audio: true,
    });
    originalStream = localStream;
    screenStream = displayStream;
    localStream = displayStream;
    isScreenSharing = true;
    localVideo.srcObject = displayStream;
    if (serverPc && serverPc.signalingState !== "closed") {
      await initiateHLSConnection(displayStream);
    }
    for (const [_, p2pPc] of peerConnections) {
      if (p2pPc.signalingState !== "closed") {
        await replaceTracksOnP2PConnection(p2pPc, displayStream);
      }
    }
    displayStream.getVideoTracks()[0].onended = () => stopScreenSharing();
  } catch (error) {
    alert("Could not start screen sharing. Please check permissions.");
  }
  updateUI();
};

const stopScreenSharing = async () => {
  if (!originalStream) return;
  if (screenStream) {
    for (const track of screenStream.getTracks()) {
      track.stop();
    }
    screenStream = null;
  }
  localStream = originalStream;
  isScreenSharing = false;
  localVideo.srcObject = originalStream;
  if (serverPc && serverPc.signalingState !== "closed") {
    await initiateHLSConnection(originalStream);
  }
  for (const [_, p2pPc] of peerConnections) {
    if (p2pPc.signalingState !== "closed") {
      await replaceTracksOnP2PConnection(p2pPc, originalStream);
    }
  }
  originalStream = null;
  updateUI();
};

document.addEventListener("DOMContentLoaded", () => {
  localVideo = document.getElementById("local-video") as HTMLVideoElement;
  remoteVideosContainer = document.getElementById(
    "remote-videos-container",
  ) as HTMLDivElement;
  startStreamBtn = document.getElementById(
    "start-stream-btn",
  ) as HTMLButtonElement;
  activeControls = document.getElementById("active-controls") as HTMLDivElement;
  shareScreenBtn = document.getElementById(
    "share-screen-btn",
  ) as HTMLButtonElement;
  stopShareBtn = document.getElementById("stop-share-btn") as HTMLButtonElement;
  wsStatusEl = document.getElementById("ws-status") as HTMLElement;
  hlsStatusEl = document.getElementById("hls-status") as HTMLElement;
  participantsCountEl = document.getElementById(
    "participants-count",
  ) as HTMLElement;
  screenSharingNotice = document.getElementById(
    "screen-sharing-notice",
  ) as HTMLElement;
  compositeReadyStatus = document.getElementById(
    "composite-ready-status",
  ) as HTMLElement;
  compositeReadyNotice = document.getElementById(
    "composite-ready-notice",
  ) as HTMLElement;
  waitingNotice = document.getElementById("waiting-notice") as HTMLElement;
  clientIdDisplay = document.getElementById("client-id-display") as HTMLElement;
  localVideoLabel = document.getElementById("local-video-label") as HTMLElement;
  localVideoScreenLabel = document.getElementById(
    "local-video-screen-label",
  ) as HTMLElement;

  const shortClientId = clientId.substring(0, 8);
  clientIdDisplay.textContent = shortClientId;
  localVideoLabel.textContent = shortClientId;

  startStreamBtn.addEventListener("mousedown", startStreaming);
  shareScreenBtn.addEventListener("mousedown", startScreenSharing);
  stopShareBtn.addEventListener("mousedown", stopScreenSharing);

  const wsUrlWithClientId = `${WS_URL_BASE}?clientId=${clientId}`;
  ws = new WebSocket(wsUrlWithClientId);
  ws.onopen = () => {
    isWsConnected = true;
    updateUI();
    sendSignalingMessage({
      type: "signal-initiate-p2p",
      payload: { clientId: clientId },
    });
    if (localStream) {
      initiateHLSConnection(localStream);
      initiateP2PConnectionsWithExistingPeers(localStream);
    }
  };
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data as string) as SignalingMessage;
    switch (message.type) {
      case "server-answer":
        if (
          serverPc &&
          message.payload.sdp &&
          serverPc.signalingState !== "closed"
        ) {
          await serverPc.setRemoteDescription(
            new RTCSessionDescription(message.payload.sdp),
          );
          if (pendingServerCandidates.length > 0) {
            for (const candidate of pendingServerCandidates) {
              await serverPc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingServerCandidates = [];
          }
        }
        break;
      case "server-candidate":
        if (
          serverPc &&
          message.payload.candidate &&
          serverPc.signalingState !== "closed"
        ) {
          if (serverPc.remoteDescription) {
            await serverPc.addIceCandidate(
              new RTCIceCandidate(message.payload.candidate),
            );
          } else {
            pendingServerCandidates.push(
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
          if (!peerConnections.has(message.payload.fromPeerID)) {
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
    }
  };
  ws.onerror = () => {
    isWsConnected = false;
    updateUI();
  };
  ws.onclose = () => {
    ws = null;
    isWsConnected = false;
    updateUI();
  };
});

window.onbeforeunload = () => {
  serverPc?.close();
  for (const pc of peerConnections.values()) {
    pc.close();
  }
  ws?.close();
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }
};
