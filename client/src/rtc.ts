import type { PublishedTrack } from '../../shared/protocol';

type SessionDescription = { readonly type: RTCSdpType; readonly sdp: string };

type PullReply = { readonly sessionDescription?: SessionDescription; readonly requiresImmediateRenegotiation?: boolean; readonly errorDescription?: string };

const ICE_SERVERS: ReadonlyArray<RTCIceServer> = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const api = async <T>(path: string, body: unknown, method = 'POST'): Promise<T> => {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);

  return response.json() as Promise<T>;
};

export type LiveState = 'connecting' | 'live' | 'stalled' | 'failed';

export type LiveViewer = { readonly close: () => void };

export const watchTrack = async (track: PublishedTrack, video: HTMLVideoElement, onState: (state: LiveState, detail: string) => void): Promise<LiveViewer> => {
  const peer = new RTCPeerConnection({ iceServers: [...ICE_SERVERS], bundlePolicy: 'max-bundle' });
  const remote = new MediaStream();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    peer.close();
    video.srcObject = null;
  };

  peer.ontrack = (event) => {
    remote.addTrack(event.track);
    video.srcObject = remote;
    void video.play().catch(() => undefined);
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') onState('failed', 'connection failed');

    if (peer.connectionState === 'disconnected') onState('stalled', 'reconnecting');
  };
  video.onplaying = () => onState('live', `${video.videoWidth}x${video.videoHeight}`);
  video.onwaiting = () => onState('stalled', 'waiting for frames');

  try {
    peer.addTransceiver('video', { direction: 'recvonly' });
    await peer.setLocalDescription(await peer.createOffer());
    const session = await api<{ readonly sessionId: string; readonly sessionDescription: SessionDescription }>('/api/rtc/sessions', { sessionDescription: { type: 'offer', sdp: peer.localDescription?.sdp ?? '' } });
    await peer.setRemoteDescription(session.sessionDescription);
    const pulled = await api<PullReply>(`/api/rtc/sessions/${session.sessionId}/tracks`, { tracks: [{ location: 'remote', sessionId: track.sessionId, trackName: track.trackName }] });

    if (pulled.errorDescription) throw new Error(pulled.errorDescription);

    if (pulled.requiresImmediateRenegotiation && pulled.sessionDescription) {
      await peer.setRemoteDescription(pulled.sessionDescription);
      await peer.setLocalDescription(await peer.createAnswer());
      await api(`/api/rtc/sessions/${session.sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp: peer.localDescription?.sdp ?? '' } }, 'PUT');
    }
  } catch (error) {
    close();
    onState('failed', error instanceof Error ? error.message : 'could not connect');
  }

  return { close };
};
