export interface DirectSignalPayload {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  toPeerID: string;
  fromPeerID?: string;
}

export interface SDPPayload {
  sdp: RTCSessionDescriptionInit;
}

export interface CandidatePayload {
  candidate: RTCIceCandidateInit;
}

export interface InitiateP2PPayload {
  clientId?: string;
  fromPeerID?: string;
}

export interface AnswerMessage {
  type: "answer";
  payload: SDPPayload;
}

export interface CandidateMessage {
  type: "candidate";
  payload: CandidatePayload;
}

export interface DirectOfferMessage {
  type: "direct-offer";
  payload: DirectSignalPayload;
}

export interface DirectAnswerMessage {
  type: "direct-answer";
  payload: DirectSignalPayload;
}

export interface DirectCandidateMessage {
  type: "direct-candidate";
  payload: DirectSignalPayload;
}

export interface InitiateP2PMessage {
  type: "signal-initiate-p2p";
  payload: InitiateP2PPayload;
}

export type SignalingMessage =
  | AnswerMessage
  | CandidateMessage
  | DirectOfferMessage
  | DirectAnswerMessage
  | DirectCandidateMessage
  | InitiateP2PMessage;
