
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Camera,
  CameraOff,
  CheckCircle2,
  CircleHelp,
  Download,
  FileImage,
  LoaderCircle,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { createWorker, type Worker } from "tesseract.js";

type Direction = "IN" | "OUT";

type Entry = {
  id: string;
  plate: string;
  direction: Direction;
  time: string;
  source: "Camera" | "Manual" | "Image";
};

const STORE = "gateflow-bus-events-v1";
const SCAN_MS = 2500;
const CONFIRM_COUNT = 2;
const DUPLICATE_MS = 12000;

function readStoredEntries(): Entry[] {
  try {
    const saved = localStorage.getItem(STORE);
    if (!saved) return [];
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatPlate(value: string): string {
  return normalizePlate(value);
}

function extractPlate(text: string): string | null {
  const cleaned = text
    .toUpperCase()
    .replace(/[|]/g, "I")
    .replace(/[^A-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ");

  const patterns = [
    /\b([A-Z]{2})\s*[- ]?\s*(\d{1,2})\s*[- ]?\s*([A-Z]{1,3})\s*[- ]?\s*(\d{1,4})\b/g,
    /\b([A-Z]{2})\s*[- ]?\s*(\d{2})\s*[- ]?\s*(\d{4})\b/g,
  ];

  for (const pattern of patterns) {
    const matches = [...cleaned.matchAll(pattern)];

    for (const match of matches) {
      const candidate = normalizePlate(match[0]);

      if (
        candidate.length >= 8 &&
        candidate.length <= 10 &&
        /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(candidate)
      ) {
        return candidate;
      }
    }
  }

  return null;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>(readStoredEntries);
  const [plateInput, setPlateInput] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState("Camera is off");
  const [error, setError] = useState("");
  const [ocrReady, setOcrReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"ALL" | Direction>("ALL");
  const [imageBusy, setImageBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const cameraOnRef = useRef(false);
  const mountedRef = useRef(true);
  const entriesRef = useRef<Entry[]>(entries);

  const candidateRef = useRef("");
  const candidateCountRef = useRef(0);
  const lastRecordedRef = useRef<{ plate: string; time: number } | null>(
    null
  );

  useEffect(() => {
    entriesRef.current = entries;
    try {
      localStorage.setItem(STORE, JSON.stringify(entries));
    } catch {
      setError("Could not save records in this browser.");
    }
  }, [entries]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function initializeOCR() {
      try {
        const worker = await createWorker("eng");

        if (cancelled) {
          await worker.terminate();
          return;
        }

        workerRef.current = worker;
        setOcrReady(true);
      } catch (err) {
        console.error("OCR initialization failed:", err);
        if (!cancelled) {
          setError("OCR could not start. Refresh the page and try again.");
        }
      }
    }

    void initializeOCR();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      runningRef.current = false;

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      const worker = workerRef.current;
      workerRef.current = null;

      if (worker) {
        void worker.terminate();
      }
    };
  }, []);

  const recordPlate = useCallback(
    (rawPlate: string, direction?: Direction, source: Entry["source"] = "Manual") => {
      const plate = formatPlate(rawPlate);

      if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(plate)) {
        setError("Enter a valid registration number, for example TN01AB1234.");
        return;
      }

      const previous = entriesRef.current[0];
      const nextDirection =
        direction ?? (previous?.direction === "IN" ? "OUT" : "IN");

      const entry: Entry = {
        id: makeId(),
        plate,
        direction: nextDirection,
        time: new Date().toISOString(),
        source,
      };

      const updated = [entry, ...entriesRef.current];
      entriesRef.current = updated;
      setEntries(updated);
      setPlateInput("");
      setError("");
      setCameraStatus(`${plate} recorded ${nextDirection}`);
    },
    []
  );

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    cameraOnRef.current = false;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }

    busyRef.current = false;
    setProcessing(false);
    setCameraOn(false);
    setCameraStatus("Camera is off");
  }, []);

  const openRearCamera = useCallback(async (): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera access is unavailable. Open the site using HTTPS or localhost."
      );
    }

    // Ask the browser for its rear-facing camera first. Do not open several
    // cameras in succession, which can cause flickering and lens switching.
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  }, []);

  const scanFrame = useCallback(async () => {
    if (
      !runningRef.current ||
      !cameraOnRef.current ||
      busyRef.current
    ) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const worker = workerRef.current;

    if (
      !video ||
      !canvas ||
      !worker ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    busyRef.current = true;
    setProcessing(true);

    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas is unavailable.");

      // Scan a central crop instead of repeatedly processing the entire image.
      // This also reduces OCR processing time on older laptops and phones.
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const cropWidth = Math.floor(sourceWidth * 0.88);
      const cropHeight = Math.floor(sourceHeight * 0.68);
      const cropX = Math.floor((sourceWidth - cropWidth) / 2);
      const cropY = Math.floor((sourceHeight - cropHeight) / 2);

      canvas.width = Math.min(cropWidth * 1.5, 1800);
      canvas.height = Math.min(cropHeight * 1.5, 1200);

      ctx.filter = "grayscale(1) contrast(1.35)";
      ctx.drawImage(
        video,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );
      ctx.filter = "none";

      const result = await worker.recognize(canvas);
      if (!runningRef.current || !cameraOnRef.current) return;

      const plate = extractPlate(result.data.text);

      if (!plate) {
        candidateRef.current = "";
        candidateCountRef.current = 0;
        setCameraStatus("Scanning — keep the plate close, clear and well lit.");
        return;
      }

      if (candidateRef.current === plate) {
        candidateCountRef.current += 1;
      } else {
        candidateRef.current = plate;
        candidateCountRef.current = 1;
      }

      setCameraStatus(
        `Plate candidate: ${plate} (${candidateCountRef.current}/${CONFIRM_COUNT})`
      );

      if (candidateCountRef.current < CONFIRM_COUNT) return;

      const now = Date.now();
      const last = lastRecordedRef.current;

      // Do not repeatedly record the same plate every scan cycle.
      if (
        last?.plate === plate &&
        now - last.time < DUPLICATE_MS
      ) {
        setCameraStatus(`${plate} already recorded. Waiting for the next plate.`);
        return;
      }

      lastRecordedRef.current = { plate, time: now };
      candidateRef.current = "";
      candidateCountRef.current = 0;

      // Automatic gate rule: alternate IN and OUT for successive detections.
      const latest = entriesRef.current[0];
      const direction: Direction =
        latest?.direction === "IN" ? "OUT" : "IN";

      recordPlate(plate, direction, "Camera");
    } catch (err) {
      console.error("Frame OCR failed:", err);
      if (runningRef.current && cameraOnRef.current) {
        setCameraStatus("OCR had a problem. Retrying automatically.");
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setProcessing(false);
    }
  }, [recordPlate]);

  const scheduleScan = useCallback(() => {
    if (!runningRef.current || !cameraOnRef.current) return;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;

      // Sequential scanning: the next frame starts only after this one ends.
      await scanFrame();

      if (runningRef.current && cameraOnRef.current) {
        scheduleScan();
      }
    }, SCAN_MS);
  }, [scanFrame]);

  const startCamera = useCallback(async () => {
    if (cameraOnRef.current || streamRef.current) return;

    setError("");
    setCameraStatus("Requesting camera access…");

    let stream: MediaStream | null = null;

    try {
      stream = await openRearCamera();

      // If the component was stopped/unmounted while permission was pending,
      // do not keep a newly opened camera running.
      if (!mountedRef.current || cameraOnRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        throw new Error("Camera preview is not available.");
      }

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      cameraOnRef.current = true;
      runningRef.current = true;
      setCameraOn(true);
      setCameraStatus(
        ocrReady
          ? "Camera ready. Looking for a number plate…"
          : "Camera ready. Preparing OCR…"
      );

      // Start only after the video has started. Never create overlapping loops.
      scheduleScan();
    } catch (err) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      streamRef.current = null;
      runningRef.current = false;
      cameraOnRef.current = false;
      setCameraOn(false);

      const message =
        err instanceof Error ? err.message : "Unknown camera error";

      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
      ) {
        setError(
          "Camera permission was denied. Allow camera access in your browser settings, then reload this page."
        );
      } else if (
        err instanceof DOMException &&
        err.name === "NotFoundError"
      ) {
        setError("No camera was found on this device.");
      } else {
        setError(`Could not start the camera: ${message}`);
      }

      setCameraStatus("Camera unavailable");
    }
  }, [openRearCamera, ocrReady, scheduleScan]);

  // The video element remains mounted so attaching a stream does not race
  // against conditional rendering.
  useEffect(() => {
    if (!cameraOn) return;

    const video = videoRef.current;
    if (video && streamRef.current && video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current;
      void video.play().catch((err) => {
        console.error("Video playback failed:", err);
        setError("The camera opened but the preview could not start.");
      });
    }
  }, [cameraOn]);

  const scanNow = useCallback(async () => {
    if (!cameraOnRef.current) {
      setError("Start the camera before scanning.");
      return;
    }

    if (busyRef.current) {
      setCameraStatus("A scan is already running. Please wait.");
      return;
    }

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    await scanFrame();

    if (runningRef.current && cameraOnRef.current) {
      scheduleScan();
    }
  }, [scanFrame, scheduleScan]);

  const handleManualRecord = useCallback(
    (direction: Direction) => {
      if (!plateInput.trim()) {
        setError("Enter a bus number plate first.");
        return;
      }
      recordPlate(plateInput, direction, "Manual");
    },
    [plateInput, recordPlate]
  );

  const handleImageUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      const worker = workerRef.current;
      if (!worker) {
        setError("OCR is still loading. Please try again in a moment.");
        return;
      }

      setImageBusy(true);
      setError("");

      try {
        const imageUrl = URL.createObjectURL(file);
        try {
          const result = await worker.recognize(imageUrl);
          const plate = extractPlate(result.data.text);

          if (plate) {
            setPlateInput(plate);
            setCameraStatus(`Detected ${plate} from image. Verify before recording.`);
          } else {
            setError("No readable registration number found. Try a clearer image.");
          }
        } finally {
          URL.revokeObjectURL(imageUrl);
        }
      } catch (err) {
        console.error("Image OCR failed:", err);
        setError("Could not read this image. Try a JPG or PNG with a clear plate.");
      } finally {
        setImageBusy(false);
      }
    },
    []
  );

  const clearRecords = useCallback(() => {
    if (!window.confirm("Delete all saved gate records from this browser?")) {
      return;
    }
    entriesRef.current = [];
    setEntries([]);
    lastRecordedRef.current = null;
    setError("");
  }, []);

  const exportCSV = useCallback(() => {
    const rows = [
      ["Bus Number Plate", "Direction", "Date and Time", "Source"],
      ...entries.map((entry) => [
        entry.plate,
        entry.direction,
        formatDate(entry.time),
        entry.source,
      ]),
    ];

    const csv = rows
      .map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      )
      .join("\r\n");

    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gateflow-records-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [entries]);

  const filteredEntries = entries.filter((entry) => {
    const matchesSearch = entry.plate
      .toLowerCase()
      .includes(search.toLowerCase().trim());
    const matchesDirection = filter === "ALL" || entry.direction === filter;
    return matchesSearch && matchesDirection;
  });

  const today = new Date().toDateString();
  const todayEntries = entries.filter(
    (entry) => new Date(entry.time).toDateString() === today
  );
  const todayIn = todayEntries.filter((entry) => entry.direction === "IN").length;
  const todayOut = todayEntries.filter((entry) => entry.direction === "OUT").length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <Camera size={21} />
        </div>
        <div className="brand-copy">
          <strong>GateFlow</strong>
          <span>BUS MOVEMENT MANAGEMENT</span>
        </div>
        <div className="topbar-status">
          <span className={`status-dot ${cameraOn ? "active" : ""}`} />
          {cameraOn ? "CAMERA ON" : "CAMERA OFF"}
        </div>
      </header>

      <main className="main">
        <section className="welcome">
          <div>
            <p className="eyebrow">GATE OPERATIONS</p>
            <h1>Bus number plate recognition</h1>
            <p className="muted">
              Monitor arrivals and departures with camera-assisted logging.
            </p>
          </div>
        </section>

        <section className="stats">
          <div className="stat-card">
            <span>Total records today</span>
            <strong>{todayEntries.length}</strong>
          </div>
          <div className="stat-card">
            <span>Bus arrivals</span>
            <strong>{todayIn}</strong>
          </div>
          <div className="stat-card">
            <span>Bus departures</span>
            <strong>{todayOut}</strong>
          </div>
          <div className="stat-card">
            <span>All saved records</span>
            <strong>{entries.length}</strong>
          </div>
        </section>

        <section className="workspace">
          <div className="panel scanner-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CAMERA / IMAGE OCR</p>
                <h2>Number plate scanner</h2>
              </div>
              <span className={`camera-badge ${cameraOn ? "on" : ""}`}>
                <span className="status-dot" />
                {cameraOn ? "CAMERA ON" : "CAMERA OFF"}
              </span>
            </div>

            <div className="camera-stage">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="camera-video"
                style={{
                  display: cameraOn ? "block" : "none",
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />

              {!cameraOn && (
                <div className="camera-placeholder">
                  <Camera size={36} />
                  <strong>Camera preview</strong>
                  <span>Start the camera to scan a bus number plate.</span>
                </div>
              )}

              {cameraOn && (
                <div className="camera-overlay">
                  <div className="plate-frame" />
                  <span className="frame-label">ALIGN PLATE INSIDE FRAME</span>
                </div>
              )}

              {cameraOn && (
                <div className="camera-status">
                  {processing ? (
                    <LoaderCircle className="spin" size={20} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                  <span>{cameraStatus}</span>
                </div>
              )}

              <canvas ref={canvasRef} style={{ display: "none" }} />
            </div>

            <div className="scanner-actions">
              {!cameraOn ? (
                <button
                  className="button primary"
                  onClick={() => void startCamera()}
                >
                  <Camera size={17} />
                  Start camera
                </button>
              ) : (
                <button className="button secondary" onClick={stopCamera}>
                  <CameraOff size={17} />
                  Stop camera
                </button>
              )}

              <button
                className="button accent"
                onClick={() => void scanNow()}
                disabled={!cameraOn || !ocrReady || processing}
              >
                <Search size={17} />
                {processing ? "Scanning…" : "Scan now"}
              </button>
            </div>

            <div className="upload-divider">
              <span>OR UPLOAD A PHOTO</span>
            </div>

            <label className="upload-control">
              <FileImage size={17} />
              {imageBusy ? "Reading image…" : "Choose plate image"}
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void handleImageUpload(event)}
                disabled={!ocrReady || imageBusy}
              />
            </label>

            <div className="scanner-note">
              <CircleHelp size={17} />
              <span>
                Automatic OCR is a best-effort reader. Verify number plates
                before using official records.
              </span>
            </div>

            {!ocrReady && (
              <p className="muted small">
                Preparing OCR engine… You can wait here while it loads.
              </p>
            )}

            {error && (
              <div className="error-message" role="alert">
                <AlertCircle size={17} />
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>

          <div className="panel record-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">GATE LOG</p>
                <h2>Record bus movement</h2>
              </div>
            </div>

            <p className="muted">
              Camera detections record movement automatically. Manual entry
              is available as a fallback.
            </p>

            <label className="field-label" htmlFor="plate-input">
              BUS NUMBER PLATE
            </label>

            <div className="plate-input-wrap">
              <span className="input-prefix">IND</span>
              <input
                id="plate-input"
                value={plateInput}
                onChange={(event) =>
                  setPlateInput(event.target.value.toUpperCase())
                }
                placeholder="E.G. TN01AB1234"
                maxLength={15}
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleManualRecord("IN");
                }}
              />
              {plateInput && (
                <button
                  className="icon-button"
                  aria-label="Clear plate input"
                  onClick={() => setPlateInput("")}
                >
                  <X size={17} />
                </button>
              )}
            </div>

            <p className="field-help">
              Detected numbers can be corrected before manual recording.
            </p>

            <div className="movement-actions">
              <button
                className="button movement-button arrival"
                onClick={() => handleManualRecord("IN")}
              >
                <ArrowDownToLine size={19} />
                <span>
                  <strong>Record IN</strong>
                  <small>Manual arrival record</small>
                </span>
              </button>

              <button
                className="button movement-button departure"
                onClick={() => handleManualRecord("OUT")}
              >
                <ArrowUpFromLine size={19} />
                <span>
                  <strong>Record OUT</strong>
                  <small>Manual departure record</small>
                </span>
              </button>
            </div>

            <div className="scan-guidance">
              <CheckCircle2 size={16} />
              <span>{cameraStatus}</span>
            </div>

            <div className="rule-note">
              <strong>Automatic rule:</strong> First confirmed plate detection
              records IN. The next confirmed visit records OUT, then
              alternates. A camera cannot determine actual direction of travel
              by itself.
            </div>
          </div>
        </section>

        <section className="panel log-panel">
          <div className="panel-heading log-heading">
            <div>
              <p className="eyebrow">HISTORY</p>
              <h2>Bus movement records</h2>
              <p className="muted">
                Search, filter and export the records saved in this browser.
              </p>
            </div>

            <div className="toolbar">
              <button
                className="button secondary compact"
                onClick={exportCSV}
                disabled={entries.length === 0}
              >
                <Download size={16} />
                Export CSV
              </button>
              <button
                className="button danger compact"
                onClick={clearRecords}
                disabled={entries.length === 0}
              >
                <Trash2 size={16} />
                Clear records
              </button>
            </div>
          </div>

          <div className="toolbar log-toolbar">
            <div className="search-box">
              <Search size={17} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search number plate…"
              />
              {search && (
                <button
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <select
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as "ALL" | Direction)
              }
              aria-label="Filter movement direction"
            >
              <option value="ALL">All movements</option>
              <option value="IN">IN only</option>
              <option value="OUT">OUT only</option>
            </select>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>BUS NUMBER PLATE</th>
                  <th>DIRECTION</th>
                  <th>DATE &amp; TIME</th>
                  <th>SOURCE</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{entry.plate}</strong>
                    </td>
                    <td>
                      <span
                        className={`direction-badge ${
                          entry.direction === "IN" ? "arrival" : "departure"
                        }`}
                      >
                        {entry.direction}
                      </span>
                    </td>
                    <td>{formatDate(entry.time)}</td>
                    <td>{entry.source}</td>
                  </tr>
                ))}

                {filteredEntries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      {entries.length === 0
                        ? "No records yet. Start the camera or enter a plate manually."
                        : "No records match your search or filter."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="app-footer">
          GateFlow · Records are stored locally in this browser. They do not
          automatically sync across devices.
        </footer>
      </main>
    </div>
  );
}
