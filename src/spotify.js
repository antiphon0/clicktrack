// Spotify Web Playback SDK integration
// Handles OAuth PKCE flow, playback state, and BPM retrieval

const SPOTIFY_CLIENT_ID = 'YOUR_CLIENT_ID'; // Set this after registering at developer.spotify.com
const SPOTIFY_REDIRECT_URI = 'http://localhost:8888/callback';
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
].join(' ');

class SpotifyIntegration {
  constructor() {
    this.accessToken = null;
    this.player = null;
    this.currentTrack = null;
    this.currentBpm = null;
    this.isConnected = false;
    this.onBpmChange = null; // callback: (bpm) => {}
    this.onTrackChange = null; // callback: (track) => {}
    this.onConnectionChange = null; // callback: (connected) => {}
    this._audioFeaturesCache = new Map();
  }

  // Generate PKCE challenge pair
  async _generatePKCE() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const verifier = btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return { verifier, challenge };
  }

  // Start OAuth PKCE login flow
  async login() {
    const { verifier, challenge } = await this._generatePKCE();
    // Store verifier for the token exchange
    sessionStorage.setItem('spotify_pkce_verifier', verifier);

    const params = new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      scope: SPOTIFY_SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });

    window.location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  // Exchange auth code for access token
  async handleCallback(code) {
    const verifier = sessionStorage.getItem('spotify_pkce_verifier');
    if (!verifier) throw new Error('Missing PKCE verifier');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    const data = await response.json();
    this.accessToken = data.access_token;
    sessionStorage.removeItem('spotify_pkce_verifier');
    return data;
  }

  // Initialize the Web Playback SDK player
  async initPlayer() {
    if (!this.accessToken) return;

    return new Promise((resolve) => {
      this.player = new window.Spotify.Player({
        name: 'Clicktrack',
        getOAuthToken: (cb) => cb(this.accessToken),
        volume: 0.5,
      });

      this.player.addListener('ready', ({ device_id }) => {
        console.log('Clicktrack player ready, device:', device_id);
        this.deviceId = device_id;
        this.isConnected = true;
        if (this.onConnectionChange) this.onConnectionChange(true);
        resolve(device_id);
      });

      this.player.addListener('not_ready', () => {
        this.isConnected = false;
        if (this.onConnectionChange) this.onConnectionChange(false);
      });

      this.player.addListener('player_state_changed', (playerState) => {
        if (!playerState) return;
        this._handleStateChange(playerState);
      });

      this.player.connect();
    });
  }

  async _handleStateChange(playerState) {
    const track = playerState.track_window.current_track;
    if (!track) return;

    const trackId = track.id;
    if (this.currentTrack?.id !== trackId) {
      this.currentTrack = {
        id: trackId,
        name: track.name,
        artist: track.artists.map((a) => a.name).join(', '),
        album: track.album.name,
        artUrl: track.album.images[0]?.url,
      };

      const bpm = await this._fetchBpm(trackId);
      if (bpm !== this.currentBpm) {
        this.currentBpm = bpm;
        if (this.onBpmChange) this.onBpmChange(bpm);
      }

      if (this.onTrackChange) this.onTrackChange(this.currentTrack);
    }
  }

  async _fetchBpm(trackId) {
    if (this._audioFeaturesCache.has(trackId)) {
      return this._audioFeaturesCache.get(trackId);
    }

    const response = await fetch(
      `https://api.spotify.com/v1/audio-features/${trackId}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) return null;

    const features = await response.json();
    const bpm = Math.round(features.tempo);
    this._audioFeaturesCache.set(trackId, bpm);
    return bpm;
  }

  // Get current playback position (ms) for beat sync
  async getPlaybackPosition() {
    if (!this.player) return null;
    const state = await this.player.getCurrentState();
    if (!state) return null;
    return state.position;
  }

  disconnect() {
    if (this.player) {
      this.player.disconnect();
      this.player = null;
    }
    this.isConnected = false;
    this.accessToken = null;
    if (this.onConnectionChange) this.onConnectionChange(false);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SpotifyIntegration };
}
if (typeof window !== 'undefined') {
  window.SpotifyIntegration = SpotifyIntegration;
}
