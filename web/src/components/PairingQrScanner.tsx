import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";

interface PairingQrScannerProps {
  disabled?: boolean;
  onScan: (value: string) => void;
}

type ScannerMode = "idle" | "starting" | "live" | "processing";

const LIVE_CAMERA_UNAVAILABLE_COPY =
  "Live camera scan needs HTTPS or localhost in this browser. Use the camera-photo fallback below if this page is opened over a LAN IP.";

export function PairingQrScanner({ disabled = false, onScan }: PairingQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameHandleRef = useRef<number | null>(null);
  const scanInFlightRef = useRef(false);

  const [mode, setMode] = useState<ScannerMode>("idle");
  const [status, setStatus] = useState("Scan the pairing QR from your Mac, or use a camera photo.");
  const [error, setError] = useState("");

  const liveCameraSupported = useMemo(() => {
    return (
      typeof window !== "undefined"
      && window.isSecureContext
      && typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia)
    );
  }, []);

  useEffect(() => {
    return () => {
      stopLiveScan();
    };
  }, []);

  async function startLiveScan() {
    if (disabled || mode === "starting" || mode === "processing") {
      return;
    }
    if (!liveCameraSupported) {
      setError(LIVE_CAMERA_UNAVAILABLE_COPY);
      return;
    }

    stopLiveScan();
    setError("");
    setStatus("Starting camera…");
    setMode("starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("The scanner preview is unavailable.");
      }

      video.srcObject = stream;
      await video.play();
      setMode("live");
      setStatus("Point the camera at the QR on your Mac.");
      scheduleFrame();
    } catch (scanError) {
      stopLiveScan();
      setMode("idle");
      setError(scanError instanceof Error ? scanError.message : "Unable to access the camera.");
    }
  }

  function stopLiveScan() {
    if (frameHandleRef.current !== null) {
      cancelAnimationFrame(frameHandleRef.current);
      frameHandleRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    scanInFlightRef.current = false;
  }

  function scheduleFrame() {
    frameHandleRef.current = window.requestAnimationFrame(scanVideoFrame);
  }

  function scanVideoFrame() {
    if (scanInFlightRef.current) {
      scheduleFrame();
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleFrame();
      return;
    }

    const result = decodeSourceIntoCanvas(video, canvas);
    if (result) {
      void commitScan(result);
      return;
    }

    scheduleFrame();
  }

  async function handleImageCapture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled || mode === "processing") {
      return;
    }

    setError("");
    setMode("processing");
    setStatus("Reading captured image…");

    try {
      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("The QR decoder is unavailable.");
      }
      const result = await decodeFileIntoCanvas(file, canvas);
      if (!result) {
        throw new Error("No QR code was found in that image.");
      }
      await commitScan(result);
    } catch (scanError) {
      setMode("idle");
      setError(scanError instanceof Error ? scanError.message : "Unable to read the image.");
    }
  }

  async function commitScan(value: string) {
    stopLiveScan();
    scanInFlightRef.current = true;
    setMode("processing");
    setError("");
    setStatus("QR detected. Pairing with the Mac…");

    try {
      onScan(value);
      setStatus("QR detected. Pairing request sent.");
    } finally {
      scanInFlightRef.current = false;
      setMode("idle");
    }
  }

  const liveButtonLabel = mode === "live" || mode === "starting" ? "Stop camera" : "Scan live";

  return (
    <section className="scanner-card">
      <div className="setup-card__header">
        <p className="eyebrow">Fastest path</p>
        <h3>Scan the pairing QR</h3>
      </div>

      <div className="scanner-card__preview">
        <video ref={videoRef} className="scanner-card__video" playsInline muted />
        {mode !== "live" ? (
          <div className="scanner-card__placeholder">
            <strong>Camera ready for the Mac QR</strong>
            <span>Open the QR on your laptop terminal, then scan it here.</span>
          </div>
        ) : null}
        <div className="scanner-card__frame" aria-hidden="true" />
      </div>

      <div className="scanner-card__actions">
        <button
          type="button"
          className="chip chip--primary"
          disabled={disabled}
          onClick={() => {
            if (mode === "live" || mode === "starting") {
              stopLiveScan();
              setMode("idle");
              setStatus("Camera stopped. You can start it again or use a photo.");
              return;
            }
            void startLiveScan();
          }}
        >
          {liveButtonLabel}
        </button>

        <label className={`chip chip--ghost scanner-card__upload ${disabled ? "scanner-card__upload--disabled" : ""}`}>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={disabled}
            onChange={handleImageCapture}
          />
          Use photo
        </label>
      </div>

      <p className="scanner-card__status">{error || status}</p>
      {!liveCameraSupported ? (
        <p className="scanner-card__hint">{LIVE_CAMERA_UNAVAILABLE_COPY}</p>
      ) : null}

      <canvas ref={canvasRef} className="scanner-card__canvas" aria-hidden="true" />
    </section>
  );
}

function decodeSourceIntoCanvas(source: CanvasImageSource, canvas: HTMLCanvasElement): string | null {
  const sourceDimensions = measureSource(source);
  if (!sourceDimensions) {
    return null;
  }

  const { width, height } = fitDecodeSurface(sourceDimensions.width, sourceDimensions.height);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("The QR decoder could not start.");
  }

  context.drawImage(source, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const result = jsQR(image.data, width, height, {
    inversionAttempts: "attemptBoth",
  });

  return result?.data?.trim() || null;
}

async function decodeFileIntoCanvas(file: File, canvas: HTMLCanvasElement): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return decodeSourceIntoCanvas(image, canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load the captured image."));
    image.src = source;
  });
}

function measureSource(source: CanvasImageSource): { width: number; height: number } | null {
  if (source instanceof HTMLVideoElement) {
    return source.videoWidth > 0 && source.videoHeight > 0
      ? { width: source.videoWidth, height: source.videoHeight }
      : null;
  }
  if (source instanceof HTMLImageElement) {
    return source.naturalWidth > 0 && source.naturalHeight > 0
      ? { width: source.naturalWidth, height: source.naturalHeight }
      : null;
  }
  if (source instanceof HTMLCanvasElement) {
    return { width: source.width, height: source.height };
  }
  if ("width" in source && "height" in source) {
    const width = Number(source.width);
    const height = Number(source.height);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function fitDecodeSurface(width: number, height: number) {
  const maxEdge = 1400;
  if (Math.max(width, height) <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
