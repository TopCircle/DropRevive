/**
 * ICE servers for the direct-transfer RTCPeerConnection.
 * Public STUN only: it lets each side learn its public address so peers on
 * different networks can often connect directly. STUN never sees file content.
 * No TURN, so nothing is ever relayed.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

export const PEER_CONFIG: RTCConfiguration = { iceServers: ICE_SERVERS };
