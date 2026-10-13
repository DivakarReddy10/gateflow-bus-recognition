
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  ScanLine,
  BusFront,
  Clock3,
  ArrowDownToLine,
  ArrowUpFromLine,
  Search,
  Download,
  Trash2,
  CheckCircle2,
  AlertCircle,
  X,
  RefreshCw,
} from 'lucide-react';
import Tesseract from 'tesseract.js';

type Direction = 'IN' | 'OUT';

type Entry = {
  id: string;
  plate: string;
  direction: Direction;
  time: string;
  source: 'camera' | 'manual';
};

type VisitState = {
  lastSeen: number;
  detections: number;
  recorded: boolean;
};

const STORE = 'gateflow-bus-events-v1';

// Adjust these values to tune automatic detection.
const ABSENCE_MS = 15000;
const SCAN_INTERVAL_MS = 2000;
const REQUIRED_DETECTIONS = 2;

const cleanPlate = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^IND(?=[A-Z0-9])/, '')
    .slice(0, 12);

const isValidPlate = (value: string) =>
  /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}$/.test(value);

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

export default function App() {
  const [events, setEvents] = useState<Entry[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(STORE) || '[]'
      ) as Entry[];
    } catch {
      return [];
    }
  });

  const [plate, setPlate] = useState('');
  const [query, setQuery] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    'Start the camera to enable automatic IN/OUT recording.'
  );
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'ALL' | Direction>('ALL');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scanTimerRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const cameraOnRef = useRef(false);
  const eventsRef = useRef<Entry[]>(events);
  const visitsRef = useRef<Map<string, VisitState>>(new Map());

  // Keep refs current so asynchronous OCR uses the latest data.
  useEffect(() => {
    eventsRef.current = events;
    localStorage.setItem(STORE, JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    cameraOnRef.current = cameraOn;
  }, [cameraOn]);

  // Attach the camera stream after the video element renders.
  useEffect(() => {
    if (!cameraOn) return;

    const video = videoRef.current;
    const stream = streamRef.current;

    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;

    void video.play().catch(() => {
      setError(
        'Video playback failed. Stop and restart the camera.'
      );
    });

    return () => {
      video.onloadedmetadata = null;
    };
  }, [cameraOn]);

  useEffect(() => {
    return () => {
      if (scanTimerRef.current !== null) {
        window.clearInterval(scanTimerRef.current);
      }

      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  }, []);

  const latestByPlate = useMemo(() => {
    const map = new Map<string, Entry>();

    [...events]
      .sort((a, b) => a.time.localeCompare(b.time))
      .forEach((event) => map.set(event.plate, event));

    return map;
  }, [events]);

  const busesInside = [...latestByPlate.values()].filter(
    (event) => event.direction === 'IN'
  ).length;

  const todayEvents = events.filter(
    (event) =>
      new Date(event.time).toDateString() ===
      new Date().toDateString()
  );

  const normalizedQuery = cleanPlate(query);

  const filtered = [...events]
    .filter(
      (event) =>
        (filter === 'ALL' || event.direction === filter) &&
        (!normalizedQuery || event.plate.includes(normalizedQuery))
    )
    .sort((a, b) => b.time.localeCompare(a.time));

  async function startCamera() {
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        'Camera access is unavailable. Open the app on localhost or HTTPS.'
      );
      return;
    }

    try {
      let stream: MediaStream;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });

      streamRef.current = stream;

      // Reset tracking for a fresh camera session.
      visitsRef.current.clear();
      scanningRef.current = false;

      setCameraOn(true);
      setMessage(
        'Camera started. Automatic plate scanning will begin shortly.'
      );
    } catch (err) {
      console.error('Camera error:', err);
      setError(
        'Could not access the camera. Allow camera permission in Chrome and try again.'
      );
    }
  }

  function stopCamera() {
    cameraOnRef.current = false;

    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });

    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    visitsRef.current.clear();
    scanningRef.current = false;
    setCameraOn(false);
    setBusy(false);
    setMessage('Camera stopped. Automatic scanning is paused.');
  }

  // Determine the next movement using the most recent saved event.
  function saveEvent(
    detectedPlate: string,
    source: 'camera' | 'manual',
    requestedDirection?: Direction
  ) {
    const normalized = cleanPlate(detectedPlate);

    if (!isValidPlate(normalized)) {
      setError(
        `Invalid-looking plate: ${normalized}. Check the registration number.`
      );
      return false;
    }

    const last = [...eventsRef.current]
      .filter((event) => event.plate === normalized)
      .sort((a, b) => b.time.localeCompare(a.time))[0];

    const next: Direction =
      requestedDirection ??
      (last?.direction === 'IN' ? 'OUT' : 'IN');

    if (last?.direction === next) {
      setMessage(
        `${normalized} is already marked ${next}. No duplicate record added.`
      );
      return false;
    }

    const event: Entry = {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random()}`,
      plate: normalized,
      direction: next,
      time: new Date().toISOString(),
      source,
    };

    // Update the ref immediately to avoid duplicate records from
    // overlapping asynchronous OCR/state updates.
    const updated = [event, ...eventsRef.current];
    eventsRef.current = updated;
    setEvents(updated);

    setPlate(normalized);
    setError('');
    setMessage(
      `Automatic ${next}: ${normalized} at ${formatTime(event.time)}`
    );

    return true;
  }

  // OCR one camera frame.
  async function scanAutomatically() {
    if (
      !cameraOnRef.current ||
      scanningRef.current
    ) {
      return;
    }

    const video = videoRef.current;

    if (
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return;
    }

    scanningRef.current = true;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');
      if (!context) return;

      context.drawImage(video, 0, 0);

      const result = await Tesseract.recognize(canvas, 'eng');
      if (!cameraOnRef.current) return;

      const rawText = result.data.text.toUpperCase();

      // Match common Indian registration formats even if OCR includes
      // spaces between the state, district, series and number.
      const candidates =
        rawText.match(
          /[A-Z]{2}[\s-]*\d{1,2}[\s-]*[A-Z]{1,3}[\s-]*\d{3,4}/g
        ) ?? [];

      const plateCandidates = [
        ...new Set(candidates.map(cleanPlate).filter(isValidPlate)),
      ];

      const now = Date.now();

      // Mark previously tracked plates absent when not recognized for
      // the configured interval. The same plate can then start a new visit.
      for (const [trackedPlate, state] of visitsRef.current.entries()) {
        if (
          now - state.lastSeen > ABSENCE_MS &&
          !plateCandidates.includes(trackedPlate)
        ) {
          visitsRef.current.delete(trackedPlate);
        }
      }

      if (plateCandidates.length === 0) {
        return;
      }

      // This simple OCR approach handles one plate candidate per frame.
      // Multiple candidates are ignored to reduce accidental recordings.
      if (plateCandidates.length !== 1) {
        return;
      }

      const detected = plateCandidates[0];
      const previous = visitsRef.current.get(detected);

      if (!previous) {
        visitsRef.current.set(detected, {
          lastSeen: now,
          detections: 1,
          recorded: false,
        });

        setMessage(`Plate candidate seen: ${detected}. Confirming…`);
        return;
      }

      // Keep the detection alive while the plate remains visible.
      previous.lastSeen = now;
      previous.detections += 1;

      if (
        previous.detections >= REQUIRED_DETECTIONS &&
        !previous.recorded
      ) {
        const saved = saveEvent(detected, 'camera');
        previous.recorded = saved;
      }
    } catch (err) {
      console.error('Automatic OCR failed:', err);
      setMessage(
        'OCR could not read this frame. Keep the plate clear and well lit.'
      );
    } finally {
      scanningRef.current = false;
    }
  }

  // Automatically repeat OCR while the camera is running.
  useEffect(() => {
    if (!cameraOn) return;

    scanTimerRef.current = window.setInterval(() => {
      void scanAutomatically();
    }, SCAN_INTERVAL_MS);

    return () => {
      if (scanTimerRef.current !== null) {
        window.clearInterval(scanTimerRef.current);
        scanTimerRef.current = null;
      }
    };
  }, [cameraOn]);

  async function readImage(image: Blob | string) {
    setBusy(true);
    setError('');
    setMessage('Reading image…');

    try {
      const result = await Tesseract.recognize(image, 'eng');
      const rawText = result.data.text.toUpperCase();

      const candidates =
        rawText.match(
          /[A-Z]{2}[\s-]*\d{1,2}[\s-]*[A-Z]{1,3}[\s-]*\d{3,4}/g
        ) ?? [];

      const detected = candidates.map(cleanPlate).find(isValidPlate);

      if (detected) {
        setPlate(detected);
        setMessage(`Plate read: ${detected}.`);
      } else {
        setMessage(
          'No valid-looking plate found. Try a closer, clearer image.'
        );
      }
    } catch (err) {
      console.error('Image OCR failed:', err);
      setError('Could not process the image. Try another photo.');
    } finally {
      setBusy(false);
    }
  }

  async function capture() {
    const video = videoRef.current;

    if (!video || !video.videoWidth) {
      setError('Wait for the camera preview to appear first.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');

    if (!context) return;

    context.drawImage(video, 0, 0);

    canvas.toBlob(
      async (blob) => {
        if (blob) await readImage(blob);
      },
      'image/jpeg',
      0.95
    );
  }

  function recordManual(direction?: Direction) {
    const normalized = cleanPlate(plate);

    if (!isValidPlate(normalized)) {
      setError(
        'Enter a valid-looking registration number, such as TN01AB1234.'
      );
      return;
    }

    saveEvent(normalized, 'manual', direction);
  }

  function exportCsv() {
    const rows = [
      ['Plate number', 'Direction', 'Date', 'Time', 'Method'],
      ...filtered.map((event) => [
        event.plate,
        event.direction,
        formatDate(event.time),
        formatTime(event.time),
        event.source,
      ]),
    ];

    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');

    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    );

    const link = document.createElement('a');
    link.href = url;
    link.download = 'bus-gate-records.csv';
    link.click();

    URL.revokeObjectURL(url);
  }

  function removeAll() {
    if (
      confirm(
        'Delete all bus gate records stored in this browser? This cannot be undone.'
      )
    ) {
      eventsRef.current = [];
      setEvents([]);
      visitsRef.current.clear();
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <BusFront size={23} />
        </div>

        <div className="brand-copy">
          <strong>GateFlow</strong>
          <span>BUS NUMBER PLATE TRACKER</span>
        </div>

        <div className="top-spacer" />
        <span className="live-dot" />
        <span className="system-label">LOCAL SYSTEM</span>
      </header>

      <main className="main">
        <section className="welcome">
          <div>
            <div className="eyebrow">COLLEGE GATE AUTOMATION</div>
            <h1>Bus movement control</h1>
            <p>
              Automatically detect bus plates and record gate
              movements.
            </p>
          </div>

          <div className="date-chip">
            <Clock3 size={16} />
            {new Date().toLocaleDateString([], {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </div>
        </section>

        <section className="stats">
          <div className="stat-card">
            <div className="stat-icon blue">
              <BusFront size={20} />
            </div>
            <div>
              <span>Buses currently inside</span>
              <strong>{busesInside}</strong>
              <small>Based on latest movement</small>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon green">
              <ArrowDownToLine size={20} />
            </div>
            <div>
              <span>Today's arrivals</span>
              <strong>
                {todayEvents.filter((e) => e.direction === 'IN').length}
              </strong>
              <small>Recorded today</small>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon amber">
              <ArrowUpFromLine size={20} />
            </div>
            <div>
              <span>Today's departures</span>
              <strong>
                {todayEvents.filter((e) => e.direction === 'OUT').length}
              </strong>
              <small>Recorded today</small>
            </div>
          </div>
        </section>

        <section className="workspace">
          <div className="panel scanner-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">CAMERA / AUTOMATIC OCR</div>
                <h2>Number plate scanner</h2>
              </div>

              <span className={`status-pill ${cameraOn ? 'active' : ''}`}>
                <span />
                {cameraOn ? 'CAMERA ON' : 'READY'}
              </span>
            </div>

            <div className="camera-stage">
              {cameraOn ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                />
              ) : (
                <div className="camera-placeholder">
                  <div className="scan-frame">
                    <ScanLine size={38} />
                  </div>
                  <strong>Position the number plate</strong>
                  <span>Keep the plate level, clear and well lit.</span>
                </div>
              )}

              {cameraOn && (
                <div className="camera-overlay">
                  <span>ALIGN PLATE INSIDE FRAME</span>
                </div>
              )}

              {busy && (
                <div className="busy-overlay">
                  <RefreshCw className="spin" size={26} />
                  <span>Reading number plate…</span>
                </div>
              )}
            </div>

            <div className="camera-actions">
              <button
                className="button secondary"
                onClick={cameraOn ? stopCamera : startCamera}
              >
                {cameraOn ? (
                  <CameraOff size={17} />
                ) : (
                  <Camera size={17} />
                )}
                {cameraOn ? 'Stop camera' : 'Start camera'}
              </button>

              <button
                className="button primary"
                onClick={capture}
                disabled={!cameraOn || busy}
              >
                <ScanLine size={17} />
                Capture & read
              </button>
            </div>

            <div className="or-divider">
              <span>OR UPLOAD A PHOTO</span>
            </div>

            <button
              className="upload-button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              Choose plate image
            </button>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readImage(file);
                event.currentTarget.value = '';
              }}
            />

            <div className="notice">
              <AlertCircle size={16} />
              <span>
                Automatic scanning runs every 2 seconds. Keep a clear
                registration plate in view. OCR may misread characters.
              </span>
            </div>
          </div>

          <div className="panel record-panel">
            <div className="eyebrow">GATE LOG</div>
            <h2>Record bus movement</h2>
            <p className="subtext">
              Camera detections record movement automatically.
              Manual entry is available as a fallback.
            </p>

            <label className="field-label" htmlFor="plate">
              BUS NUMBER PLATE
            </label>

            <div className="plate-input-wrap">
              <div className="india-tag">IND</div>
              <input
                id="plate"
                value={plate}
                onChange={(event) =>
                  setPlate(event.target.value.toUpperCase())
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') recordManual();
                }}
                placeholder="e.g. TN01AB1234"
                maxLength={14}
              />

              <button
                className="clear-input"
                onClick={() => setPlate('')}
                aria-label="Clear plate"
              >
                <X size={16} />
              </button>
            </div>

            <div className="input-hint">
              Detected plates appear here. You can edit them before manual
              recording.
            </div>

            {plate && (
              <div className="detected-card">
                <div className="detected-check">
                  <CheckCircle2 size={17} />
                </div>
                <div>
                  <span>PLATE TO RECORD</span>
                  <strong>{cleanPlate(plate)}</strong>
                </div>
                <button
                  className="edit-link"
                  onClick={() => setPlate(cleanPlate(plate))}
                >
                  Normalize
                </button>
              </div>
            )}

            {error && (
              <div className="error-message">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <div className="record-buttons">
              <button
                className="button arrival"
                onClick={() => recordManual('IN')}
              >
                <ArrowDownToLine size={18} />
                <span>
                  Record IN
                  <small>Manual arrival fallback</small>
                </span>
              </button>

              <button
                className="button departure"
                onClick={() => recordManual('OUT')}
              >
                <ArrowUpFromLine size={18} />
                <span>
                  Record OUT
                  <small>Manual departure fallback</small>
                </span>
              </button>
            </div>

            <div className="message-line">
              <CheckCircle2 size={15} />
              {message}
            </div>

            <div className="rule-note">
              <strong>Automatic rule:</strong> First confirmed detection
              records IN. After 15 seconds without detection, the next
              confirmed visit records OUT. This is an experimental
              visibility-based rule, not true direction detection.
            </div>
          </div>
        </section>

        <section className="panel log-panel">
          <div className="log-header">
            <div>
              <div className="eyebrow">MOVEMENT HISTORY</div>
              <h2>
                Recent gate records{' '}
                <span className="count-badge">{filtered.length}</span>
              </h2>
            </div>

            <button
              className="button secondary export-btn"
              onClick={exportCsv}
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>

          <div className="toolbar">
            <div className="search-box">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search plate number…"
              />
            </div>

            <div className="filter-group">
              {(['ALL', 'IN', 'OUT'] as const).map((value) => (
                <button
                  key={value}
                  className={filter === value ? 'selected' : ''}
                  onClick={() => setFilter(value)}
                >
                  {value === 'ALL'
                    ? 'All records'
                    : value === 'IN'
                      ? 'Arrivals'
                      : 'Departures'}
                </button>
              ))}
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>BUS PLATE</th>
                  <th>MOVEMENT</th>
                  <th>DATE</th>
                  <th>TIME</th>
                  <th>METHOD</th>
                </tr>
              </thead>

              <tbody>
                {filtered.slice(0, 100).map((event) => (
                  <tr key={event.id}>
                    <td>
                      <span className="plate-badge">{event.plate}</span>
                    </td>
                    <td>
                      <span
                        className={`direction ${event.direction.toLowerCase()}`}
                      >
                        {event.direction === 'IN' ? (
                          <ArrowDownToLine size={14} />
                        ) : (
                          <ArrowUpFromLine size={14} />
                        )}
                        {event.direction}
                      </span>
                    </td>
                    <td>{formatDate(event.time)}</td>
                    <td className="time-cell">
                      {formatTime(event.time)}
                    </td>
                    <td>
                      <span className="method-label">
                        {event.source === 'camera'
                          ? 'Camera / OCR'
                          : 'Manual'}
                      </span>
                    </td>
                  </tr>
                ))}

                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-state">
                      <div className="empty-icon">
                        <BusFront size={24} />
                      </div>
                      <strong>No records yet</strong>
                      <span>
                        Start the camera and show a clear bus plate.
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="table-footer">
            <span>
              Showing {Math.min(filtered.length, 100)} of {filtered.length}
              {' '}records · Stored in this browser
            </span>

            <button className="text-danger" onClick={removeAll}>
              <Trash2 size={14} />
              Clear records
            </button>
          </div>
        </section>

        <footer>
          GateFlow Bus Tracker <span>•</span> Browser-based prototype
          <span>•</span> Records are stored locally on this device
        </footer>
      </main>
    </div>
  );
}
