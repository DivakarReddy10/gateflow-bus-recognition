
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowUpFromLine, BusFront, Camera,
  CameraOff, CheckCircle2, Clock3, Download, History, Menu,
  Search, ShieldCheck, Trash2, UploadCloud, X, Zap
} from "lucide-react";
import { createWorker, type Worker } from "tesseract.js";
import "./styles.css";

type Direction = "IN" | "OUT";
type Source = "camera" | "image" | "manual";

type Entry = {
  id: string;
  plate: string;
  direction: Direction;
  time: string;
  source: Source;
};

const STORAGE_KEY = "gateflow-bus-events-v1";
const ABSENCE_WINDOW = 10000;
const CANDIDATE_WINDOW = 5000;
const SCAN_INTERVAL = 1200;

function cleanPlate(value: string) {
  return value.toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^IND(?=[A-Z0-9])/, "")
    .slice(0, 12);
}

function validPlate(value: string) {
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(cleanPlate(value));
}

function readEntries(): Entry[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function displayTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function displayDate(value: string) {
  return new Date(value).toLocaleDateString([], {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>(readEntries);
  const [page, setPage] = useState<"scanner" | "history">("scanner");
  const [plate, setPlate] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"ALL" | Direction>("ALL");
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [status, setStatus] = useState("Start the camera to begin automatic scanning.");
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerPromiseRef = useRef<Promise<Worker> | null>(null);
  const cameraRef = useRef(false);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // Camera presence tracking: a plate is recorded once per appearance.
  const lastSeenRef = useRef<Record<string, number>>({});
  const recordedPresenceRef = useRef<Record<string, boolean>>({});
  const candidateRef = useRef({ plate: "", count: 0, time: 0 });
  const entriesRef = useRef<Entry[]>(entries);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      setError("Storage is full. Export your records and clear old entries.");
    }
  }, [entries]);

  // Load OCR once.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const promise = createWorker("eng");
        workerPromiseRef.current = promise;
        const worker = await promise;

        await worker.setParameters({
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          preserve_interword_spaces: "0"
        });

        if (cancelled) {
          await worker.terminate();
          return;
        }

        workerRef.current = worker;
        setEngineReady(true);
        setStatus("Recognition engine ready. Start scanning.");
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError("OCR engine failed to load. Check your internet connection and refresh.");
        }
      }
    }

    void init();

    return () => {
      cancelled = true;
      cameraRef.current = false;

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }

      streamRef.current?.getTracks().forEach(track => track.stop());

      if (workerRef.current) {
        void workerRef.current.terminate();
      }
    };
  }, []);

  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(console.error);
    }
  }, [cameraOn, page]);

  // Add a movement. Camera direction alternates based on the latest saved event.
  const recordPlate = useCallback((
    raw: string,
    source: Source,
    direction?: Direction
  ) => {
    const number = cleanPlate(raw);

    if (!validPlate(number)) {
      setError("Check the plate number. Example: TN01AB1234.");
      return false;
    }

    // entriesRef is newest-first, so find() returns the latest movement.
    const previous = entriesRef.current.find(item => item.plate === number);

    const movement: Direction = direction ??
      (previous?.direction === "IN" ? "OUT" : "IN");

    const item: Entry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      plate: number,
      direction: movement,
      time: new Date().toISOString(),
      source
    };

    const updated = [item, ...entriesRef.current];
    entriesRef.current = updated;
    setEntries(updated);
    setPlate(number);
    setError("");
    setStatus(`${number} recorded as ${movement}.`);

    return true;
  }, []);

  async function getWorker() {
    if (workerRef.current) return workerRef.current;

    if (workerPromiseRef.current) {
      const worker = await workerPromiseRef.current;
      workerRef.current = worker;
      return worker;
    }

    throw new Error("Recognition engine is not ready.");
  }

  const recognize = useCallback(async (
    image: HTMLCanvasElement | File,
    source: "camera" | "image"
  ) => {
    if (busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setError("");

    try {
      const worker = await getWorker();
      const result = await worker.recognize(image);
      const text = result.data.text.toUpperCase();

      const tokens = text.split(/[\s\n:;|]+/).map(cleanPlate);
      const compact = cleanPlate(text);

      const match = [...tokens, compact]
        .filter(validPlate)
        .sort((a, b) => b.length - a.length)[0];

      if (!match) {
        setStatus("No plate detected in this frame. Keep scanning or use Capture now.");
        return;
      }

      setPlate(match);

      // Uploads and captures identify a plate without automatically recording it.
      if (source === "image") {
        setStatus(`Image read: ${match}. Verify the number, then choose Record IN or Record OUT.`);
        return;
      }

      const now = Date.now();
      const previousSeen = lastSeenRef.current[match] || 0;

      // IMPORTANT: check the old timestamp before updating it.
      const newAppearance =
        previousSeen === 0 || now - previousSeen >= ABSENCE_WINDOW;

      if (newAppearance) {
        recordedPresenceRef.current[match] = false;
      }

      lastSeenRef.current[match] = now;

      // Require two matching readings within the candidate window.
      const old = candidateRef.current;
      const count =
        old.plate === match && now - old.time < CANDIDATE_WINDOW
          ? old.count + 1
          : 1;

      candidateRef.current = { plate: match, count, time: now };

      // Only one record is allowed during a continuous appearance.
      if (count >= 2 && !recordedPresenceRef.current[match]) {
        // Set the flag before saving to guard against duplicate frames.
        recordedPresenceRef.current[match] = true;

        const saved = recordPlate(match, "camera");

        if (saved) {
          setStatus(`${match} recorded once for this camera appearance.`);
        } else {
          recordedPresenceRef.current[match] = false;
        }
      } else if (recordedPresenceRef.current[match]) {
        setStatus(`${match} is still in view. Duplicate frame ignored.`);
      } else {
        setStatus(`Possible plate: ${match}. Checking next frame…`);
      }
    } catch (e) {
      console.error(e);
      setError("This frame could not be read. Try Capture now or enter the plate manually.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [recordPlate]);

  const scan = useCallback(async () => {
    if (!cameraRef.current) return;

    const video = videoRef.current;

    if (
      video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      !busyRef.current
    ) {
      const scale = Math.min(1, 960 / video.videoWidth);
      const canvas = document.createElement("canvas");

      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        await recognize(canvas, "camera");
      }
    }

    if (cameraRef.current) {
      timerRef.current = window.setTimeout(() => void scan(), SCAN_INTERVAL);
    }
  }, [recognize]);

  async function startCamera() {
    setError("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera requires localhost or HTTPS. Open the deployed HTTPS website.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = stream;
      cameraRef.current = true;

      // Start a fresh tracking session.
      lastSeenRef.current = {};
      recordedPresenceRef.current = {};
      candidateRef.current = { plate: "", count: 0, time: 0 };

      setCameraOn(true);
      setStatus("Camera live. The full view is scanned automatically.");

      timerRef.current = window.setTimeout(() => void scan(), 700);
    } catch (e) {
      console.error(e);
      setError("Camera access failed. Allow permission and close other apps using the camera.");
    }
  }

  function stopCamera() {
    cameraRef.current = false;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;

    if (videoRef.current) videoRef.current.srcObject = null;

    setCameraOn(false);
    setStatus("Camera stopped. Saved records are still available.");
  }

  async function captureNow() {
    const video = videoRef.current;

    if (!video || video.readyState < 2 || !video.videoWidth) {
      setError("Wait for the camera picture to appear, then capture.");
      return;
    }

    const canvas = document.createElement("canvas");
    const scale = Math.min(1.5, 1600 / video.videoWidth);

    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext("2d");

    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      await recognize(canvas, "image");
    }
  }

  async function uploadImage(file?: File) {
    if (file) await recognize(file, "image");
  }

  function exportCsv() {
    const rows = [
      ["Plate", "Direction", "Date", "Time", "Source"],
      ...visibleEntries.map(item => [
        item.plate,
        item.direction,
        displayDate(item.time),
        displayTime(item.time),
        item.source
      ])
    ];

    const csv = rows
      .map(row => row.map(value =>
        `"${String(value).replace(/"/g, '""')}"`
      ).join(","))
      .join("\n");

    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" })
    );

    const link = document.createElement("a");
    link.href = url;
    link.download = "gateflow-bus-records.csv";
    link.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearRecords() {
    if (window.confirm("Delete all records saved in this browser?")) {
      setEntries([]);
      entriesRef.current = [];
      lastSeenRef.current = {};
      recordedPresenceRef.current = {};
      candidateRef.current = { plate: "", count: 0, time: 0 };
      setStatus("All local records cleared.");
    }
  }

  const latestByPlate = new Map<string, Entry>();

  [...entries]
    .sort((a, b) => a.time.localeCompare(b.time))
    .forEach(item => latestByPlate.set(item.plate, item));

  const insideCount = [...latestByPlate.values()]
    .filter(item => item.direction === "IN").length;

  const today = entries.filter(
    item => new Date(item.time).toDateString() === new Date().toDateString()
  );

  const visibleEntries = [...entries]
    .filter(item =>
      (filter === "ALL" || item.direction === filter) &&
      (!cleanPlate(search) || item.plate.includes(cleanPlate(search)))
    )
    .sort((a, b) => b.time.localeCompare(a.time));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-icon"><BusFront size={24} /></div>
          <div><strong>GateFlow</strong><span>SMART GATE APP</span></div>
        </div>

        <div className="nav-label">WORKSPACE</div>

        <button
          className={`nav-item ${page === "scanner" ? "nav-active" : ""}`}
          onClick={() => { setPage("scanner"); setMenuOpen(false); }}
        >
          <Camera size={18} /> Live scanner
        </button>

        <button
          className={`nav-item ${page === "history" ? "nav-active" : ""}`}
          onClick={() => { setPage("history"); setMenuOpen(false); }}
        >
          <History size={18} /> Movement history
        </button>

        <div className="sidebar-bottom">
          <div className="security-mark">
            <ShieldCheck size={18} />
            <div><strong>Local-first storage</strong><span>Records saved in this browser</span></div>
          </div>
          <div className="version">GATEFLOW · EXPO PROTOTYPE</div>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-header">
          <button
            className="mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Toggle navigation"
          >
            <Menu size={21} />
          </button>

          <div>
            <span className="header-kicker">COLLEGE TRANSPORT</span>
            <h1>{page === "scanner" ? "Live bus scanner" : "Movement history"}</h1>
          </div>

          <div className="header-status">
            <span className={`status-light ${cameraOn ? "light-on" : ""}`} />
            {cameraOn ? "CAMERA LIVE" : "SYSTEM READY"}
          </div>
        </header>

        <main className="content">
          <section className="welcome-strip">
            <div>
              <div className="eyebrow">GATE OPERATIONS</div>
              <h2>Keep the gate moving.</h2>
              <p>Recognize a plate, verify the result, and record the bus movement.</p>
            </div>
            <div className="today-chip">
              <Clock3 size={16} />
              {new Date().toLocaleDateString([], {
                weekday: "short", day: "numeric", month: "short"
              })}
            </div>
          </section>

          <section className="metric-grid">
            <div className="metric-card">
              <span className="metric-icon blue"><BusFront size={19} /></span>
              <div>
                <span>Currently inside</span>
                <strong>{insideCount}</strong>
                <small>Based on the latest recorded movement</small>
              </div>
            </div>

            <div className="metric-card">
              <span className="metric-icon green"><ArrowDownToLine size={19} /></span>
              <div>
                <span>Today's arrivals</span>
                <strong>{today.filter(item => item.direction === "IN").length}</strong>
                <small>Recorded today</small>
              </div>
            </div>

            <div className="metric-card">
              <span className="metric-icon orange"><ArrowUpFromLine size={19} /></span>
              <div>
                <span>Today's departures</span>
                <strong>{today.filter(item => item.direction === "OUT").length}</strong>
                <small>Recorded today</small>
              </div>
            </div>
          </section>

          {page === "scanner" ? (
            <section className="scanner-layout">
              <div className="surface scanner-surface">
                <div className="surface-heading">
                  <div>
                    <span className="eyebrow">CAMERA RECOGNITION</span>
                    <h3>Number plate scanner</h3>
                    <p>Automatic scanning · full camera view</p>
                  </div>
                  <span className={`pill ${cameraOn ? "pill-live" : ""}`}>
                    <span />{cameraOn ? "Live" : "Standby"}
                  </span>
                </div>

                <div className={`camera-view ${cameraOn ? "camera-running" : ""}`}>
                  {cameraOn ? (
                    <video ref={videoRef} autoPlay playsInline muted />
                  ) : (
                    <div className="camera-empty">
                      <div className="camera-symbol"><Camera size={28} /></div>
                      <strong>Ready when you are</strong>
                      <span>Start the camera to scan the whole view.</span>
                    </div>
                  )}

                  {cameraOn && <>
                    <div className="view-corner corner-tl" />
                    <div className="view-corner corner-tr" />
                    <div className="view-corner corner-bl" />
                    <div className="view-corner corner-br" />
                    <div className="view-scan-line" />
                  </>}

                  {busy && (
                    <div className="scan-working">
                      <Activity size={17} /><span>Reading frame…</span>
                    </div>
                  )}

                  <div className="camera-label">
                    <span className={`status-light ${cameraOn ? "light-on" : ""}`} />
                    {cameraOn ? "AUTO SCAN ACTIVE" : "CAMERA OFF"}
                    <span className="camera-label-right">NO FIXED PLATE BOX</span>
                  </div>
                </div>

                <div className="camera-controls">
                  <button
                    className={`btn ${cameraOn ? "btn-muted" : "btn-primary"}`}
                    onClick={cameraOn ? stopCamera : startCamera}
                  >
                    {cameraOn ? <CameraOff size={17} /> : <Camera size={17} />}
                    {cameraOn ? "Stop camera" : "Start live scan"}
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => void captureNow()}
                    disabled={!cameraOn || busy}
                  >
                    <Zap size={17} /> Capture now
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => uploadRef.current?.click()}
                    disabled={busy}
                  >
                    <UploadCloud size={17} /> Upload image
                  </button>

                  <input
                    ref={uploadRef}
                    hidden
                    type="file"
                    accept="image/*"
                    onChange={event => {
                      void uploadImage(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                </div>

                <div className={`scan-message ${error ? "message-error" : ""}`}>
                  <span className="message-icon">
                    {error ? <X size={17} /> : <Activity size={17} />}
                  </span>
                  <div>
                    <strong>
                      {error ? "Needs attention" : busy ? "Processing frame" : "Scanner status"}
                    </strong>
                    <p>{error || status}</p>
                  </div>
                </div>

                <div className="small-note">
                  <ShieldCheck size={15} />
                  OCR is best-effort. Distance, glare, motion blur and camera quality affect results.
                </div>
              </div>

              <div className="right-column">
                <div className="surface plate-surface">
                  <div className="surface-heading compact">
                    <div>
                      <span className="eyebrow">DETECTION RESULT</span>
                      <h3>Recognized plate</h3>
                    </div>
                    <CheckCircle2 className="result-check" size={25} />
                  </div>

                  <div className={`plate-display ${plate ? "plate-found" : ""}`}>
                    <span className="plate-country">IND</span>
                    <strong>{plate || "— — — — — —"}</strong>
                  </div>

                  <p className="plate-help">
                    Review the detected number. Edit it if the camera misreads a character.
                  </p>

                  <label className="input-label" htmlFor="plate-entry">
                    EDIT / ENTER NUMBER PLATE
                  </label>

                  <div className="plate-edit">
                    <input
                      id="plate-entry"
                      value={plate}
                      onChange={event => setPlate(event.target.value.toUpperCase())}
                      placeholder="TN01AB1234"
                      maxLength={12}
                    />
                    <button onClick={() => setPlate("")} aria-label="Clear plate">
                      <X size={16} />
                    </button>
                  </div>

                  <div className="movement-buttons">
                    <button
                      className="btn btn-arrival"
                      onClick={() => {
                        if (recordPlate(plate, "manual", "IN")) setPage("history");
                      }}
                    >
                      <ArrowDownToLine size={18} />
                      <span><strong>Record IN</strong><small>Bus arrives</small></span>
                    </button>

                    <button
                      className="btn btn-departure"
                      onClick={() => {
                        if (recordPlate(plate, "manual", "OUT")) setPage("history");
                      }}
                    >
                      <ArrowUpFromLine size={18} />
                      <span><strong>Record OUT</strong><small>Bus leaves</small></span>
                    </button>
                  </div>

                  <div className="record-tip">
                    <CheckCircle2 size={15} /> Confirm the plate before recording.
                  </div>
                </div>

                <div className="surface quick-status">
                  <div className="quick-icon"><Activity size={18} /></div>
                  <div>
                    <strong>{engineReady ? "Recognition engine ready" : "Preparing recognition engine"}</strong>
                    <p>
                      {engineReady
                        ? "OCR worker stays loaded for repeated scans."
                        : "The initial load may take a moment."}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <section className="surface history-surface">
              <div className="history-heading">
                <div>
                  <span className="eyebrow">GATE LOG</span>
                  <h3>Bus movement records <span className="count">{visibleEntries.length}</span></h3>
                  <p>Search, filter, and export the records saved in this browser.</p>
                </div>

                <div className="history-actions">
                  <button className="btn btn-secondary" onClick={exportCsv}>
                    <Download size={16} /> Export CSV
                  </button>
                  <button className="btn btn-danger" onClick={clearRecords}>
                    <Trash2 size={16} /> Clear records
                  </button>
                </div>
              </div>

              <div className="history-tools">
                <label className="search-input">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder="Search number plate…"
                  />
                </label>

                <div className="filter-tabs">
                  {(["ALL", "IN", "OUT"] as const).map(value => (
                    <button
                      key={value}
                      className={filter === value ? "filter-active" : ""}
                      onClick={() => setFilter(value)}
                    >
                      {value === "ALL" ? "All" : value === "IN" ? "Arrivals" : "Departures"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>BUS NUMBER PLATE</th>
                      <th>DIRECTION</th>
                      <th>DATE & TIME</th>
                      <th>SOURCE</th>
                    </tr>
                  </thead>

                  <tbody>
                    {visibleEntries.slice(0, 200).map(item => (
                      <tr key={item.id}>
                        <td><span className="table-plate">{item.plate}</span></td>
                        <td>
                          <span className={`direction-tag ${item.direction.toLowerCase()}`}>
                            {item.direction === "IN"
                              ? <ArrowDownToLine size={14} />
                              : <ArrowUpFromLine size={14} />}
                            {item.direction}
                          </span>
                        </td>
                        <td>{displayDate(item.time)} · {displayTime(item.time)}</td>
                        <td>
                          {item.source === "camera"
                            ? "Live OCR"
                            : item.source === "image"
                              ? "Image OCR"
                              : "Manual"}
                        </td>
                      </tr>
                    ))}

                    {visibleEntries.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <div className="empty-history">
                            <History size={26} />
                            <strong>No movement records yet</strong>
                            <span>Scan a plate and record the movement to see it here.</span>
                            <button className="btn btn-primary" onClick={() => setPage("scanner")}>
                              Open scanner
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="history-footer">
                <span>
                  Showing {Math.min(visibleEntries.length, 200)} of {visibleEntries.length} records · Saved on this device
                </span>
                <button className="clear-link" onClick={clearRecords}>
                  <Trash2 size={14} /> Clear all
                </button>
              </div>
            </section>
          )}

          <footer className="app-footer">
            <span><ShieldCheck size={14} /> GateFlow bus movement system</span>
            <span>College expo prototype · Local records</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
