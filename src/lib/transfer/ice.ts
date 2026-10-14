/**
 * ICE servers for the direct-transfer RTCPeerConnection.
 * Public STUN only: it lets each side learn its public address so peers on
 * different networks can often connect directly. STUN never sees file content.
 * No TURN, so nothing is ever relayed.
 *
 * Global (Cloudflare, Google) plus mainland-China servers (bilibili, hitv), since
 * Google is usually unreachable from China. The browser queries all of them in
 * parallel; separate entries so one bad server does not affect the others.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.chat.bilibili.com:3478" },
  { urls: "stun:stun.hitv.com:3478" },
];

export const PEER_CONFIG: RTCConfiguration = { iceServers: ICE_SERVERS };
