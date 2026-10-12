
"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const SERVER_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:3001";

export default function Home() {
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const roomRef = useRef("");
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const makingOffer = useRef(false);

  const [roomId, setRoomId] = useState("room-123");
  const [status, setStatus] = useState("Connecting to server...");
  const [joined, setJoined] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  useEffect(() => {
    const socket = io(SERVER_URL, {
      autoConnect: true,
      reconnection: true,
      timeout: 10000,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Socket connected:", socket.id);
      setStatus("Connected to signaling server");
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);
      setStatus(`Server connection failed: ${error.message}`);
    });

    socket.on("disconnect", (reason) => {
      console.log("Socket disconnected:", reason);
      setStatus(`Server disconnected: ${reason}`);
    });

    socket.on("joined-room", async ({ roomId, peerId }) => {
      roomRef.current = roomId;
      peerIdRef.current = peerId ?? null;
      setJoined(true);

      try {
        await startMedia();

        if (peerId) {
          setStatus("Peer found. Starting call...");
          await makeOffer(peerId);
        } else {
          setStatus("Joined room. Waiting for another user...");
        }
      } catch (error) {
        console.error("Media error:", error);
        setStatus(getErrorMessage(error));
      }
    });

    socket.on("user-joined", ({ peerId }) => {
      peerIdRef.current = peerId;
      setStatus("Peer joined. Waiting for offer...");
    });

    socket.on("offer", async ({ from, offer }) => {
      try {
        peerIdRef.current = from;
        await startMedia();

        const pc = getPeerConnection();

        if (pc.signalingState !== "stable") {
          console.warn("Ignoring offer in state:", pc.signalingState);
          return;
        }

        await pc.setRemoteDescription(offer);
        await flushCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", {
          target: from,
          answer: pc.localDescription,
        });

        setStatus("Answer sent. Connecting...");
      } catch (error) {
        console.error("Offer handling error:", error);
        setStatus(getErrorMessage(error));
      }
    });

    socket.on("answer", async ({ from, answer }) => {
      try {
        const pc = pcRef.current;

        if (!pc || peerIdRef.current !== from) return;

        if (pc.signalingState !== "have-local-offer") {
          console.warn(
            "Ignoring unexpected answer:",
            pc.signalingState
          );
          return;
        }

        await pc.setRemoteDescription(answer);
        await flushCandidates(pc);

        setStatus("Answer received. Connecting...");
      } catch (error) {
        console.error("Answer handling error:", error);
        setStatus(getErrorMessage(error));
      }
    });

    socket.on("ice-candidate", async ({ from, candidate }) => {
      if (peerIdRef.current !== from) return;

      const pc = pcRef.current;

      if (!pc || !pc.remoteDescription) {
        pendingCandidates.current.push(candidate);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.error("ICE candidate error:", error);
      }
    });

    socket.on("room-full", () => {
      setStatus("Room is full. Maximum 2 users allowed.");
    });

    socket.on("join-error", (message: string) => {
      setStatus(`Could not join room: ${message}`);
    });

    socket.on("user-left", ({ peerId }) => {
      if (peerIdRef.current !== peerId) return;

      closePeerConnection();
      peerIdRef.current = null;

      if (remoteVideo.current) {
        remoteVideo.current.srcObject = null;
      }

      setInCall(false);
      setStatus("Peer left. Waiting for another user...");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      closePeerConnection();

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        return "Camera/microphone permission denied.";
      }

      if (
        error.name === "NotFoundError" ||
        error.name === "DevicesNotFoundError"
      ) {
        return "Camera or microphone not found.";
      }

      if (error.name === "NotReadableError") {
        return "Camera/microphone is busy or unavailable.";
      }

      return `${error.name || "Error"}: ${error.message}`;
    }

    return "An unknown error occurred.";
  }

  async function startMedia() {
    if (streamRef.current) return;

    if (!window.isSecureContext) {
      throw new Error(
        "Camera needs HTTPS on phones. Open this site using HTTPS."
      );
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera API unavailable. Check HTTPS and browser support."
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });

    streamRef.current = stream;

    if (localVideo.current) {
      localVideo.current.srcObject = stream;
      await localVideo.current.play().catch(() => {});
    }

    setStatus("Camera and microphone ready");
  }

  function getPeerConnection() {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });

    streamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, streamRef.current!);
    });

    pc.ontrack = (event) => {
      if (remoteVideo.current) {
        remoteVideo.current.srcObject =
          event.streams[0] ?? new MediaStream([event.track]);

        remoteVideo.current.play().catch(() => {});
      }

      setInCall(true);
      setStatus("Video call connected");
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && peerIdRef.current) {
        socketRef.current?.emit("ice-candidate", {
          target: peerIdRef.current,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("WebRTC state:", pc.connectionState);

      switch (pc.connectionState) {
        case "connected":
          setInCall(true);
          setStatus("Video call connected");
          break;

        case "failed":
          setInCall(false);
          setStatus("WebRTC failed. A TURN server may be needed.");
          break;

        case "disconnected":
          setStatus("WebRTC connection interrupted");
          break;

        case "closed":
          setInCall(false);
          break;
      }
    };

    pcRef.current = pc;
    return pc;
  }

  async function flushCandidates(pc: RTCPeerConnection) {
    const candidates = [...pendingCandidates.current];
    pendingCandidates.current = [];

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.error("Pending ICE candidate error:", error);
      }
    }
  }

  async function makeOffer(peerId: string) {
    if (makingOffer.current) return;

    makingOffer.current = true;

    try {
      await startMedia();

      const pc = getPeerConnection();

      if (pc.signalingState !== "stable") return;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current?.emit("offer", {
        target: peerId,
        offer: pc.localDescription,
      });

      setStatus("Offer sent. Waiting for answer...");
    } catch (error) {
      console.error("Offer creation error:", error);
      setStatus(getErrorMessage(error));
    } finally {
      makingOffer.current = false;
    }
  }

  async function joinRoom() {
    const socket = socketRef.current;
    const id = roomId.trim();

    if (!socket?.connected) {
      setStatus("Signaling server is not connected.");
      return;
    }

    if (!id) {
      setStatus("Enter a room ID.");
      return;
    }

    try {
      setStatus("Requesting camera and microphone...");
      await startMedia();

      setStatus("Joining room...");
      socket.emit("join-room", id);
    } catch (error) {
      console.error("Join error:", error);
      setStatus(getErrorMessage(error));
    }
  }

  function closePeerConnection() {
    pcRef.current?.close();
    pcRef.current = null;
    pendingCandidates.current = [];
  }

  function leaveRoom() {
    const room = roomRef.current;

    if (room) {
      socketRef.current?.emit("leave-room", room);
    }

    closePeerConnection();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    peerIdRef.current = null;
    roomRef.current = "";

    if (localVideo.current) localVideo.current.srcObject = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;

    setJoined(false);
    setInCall(false);
    setMuted(false);
    setCameraOff(false);
    setStatus("You left the room");
  }

  function toggleMute() {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }

  function toggleCamera() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  }

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "40px auto",
        padding: 20,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <h1>WebRTC Video Call</h1>

      <p>
        <strong>Status:</strong> {status}
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
        }}
      >
        <input
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
          placeholder="Room ID"
          disabled={joined}
          style={{ padding: 10, minWidth: 140 }}
        />

        <button onClick={joinRoom} disabled={joined}>
          Join Call
        </button>

        <button onClick={leaveRoom} disabled={!joined}>
          Leave
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
        }}
      >
        <div>
          <h2>You</h2>
          <video
            ref={localVideo}
            autoPlay
            muted
            playsInline
            style={{
              width: "100%",
              background: "#222",
              borderRadius: 12,
              minHeight: 180,
            }}
          />
        </div>

        <div>
          <h2>Remote user</h2>
          <video
            ref={remoteVideo}
            autoPlay
            playsInline
            style={{
              width: "100%",
              background: "#222",
              borderRadius: 12,
              minHeight: 180,
            }}
          />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
        <button onClick={toggleMute} disabled={!joined}>
          {muted ? "Unmute" : "Mute"}
        </button>

        <button onClick={toggleCamera} disabled={!joined}>
          {cameraOff ? "Turn camera on" : "Turn camera off"}
        </button>
      </div>

      <p>
        {inCall
          ? "Connected to another user."
          : "Waiting for media connection..."}
      </p>
    </main>
  );
}
