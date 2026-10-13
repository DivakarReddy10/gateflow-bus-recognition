
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const STORE = 'gateflow-bus-events-v1';
const CONFIRM_MS = 12000;
const SCAN_MS = 3000;

const cleanPlate = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^IND(?=[A-Z0-9])/, '')
    .slice(0, 12);

const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

async function getMainRearCameraStream(): Promise<MediaStream> {
  const devices = navigator.mediaDevices;

  if (!devices?.getUserMedia) {
    throw new Error('Camera access requires HTTPS or localhost.');
  }

  // Request permission first so browsers can reveal camera labels.
  const temporaryStream = await devices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });

  temporaryStream.getTracks().forEach((track) => track.stop());

  const cameras = (await devices.enumerateDevices()).filter(
    (device) => device.kind === 'videoinput'
  );

  console.table(
    cameras.map((camera) => ({
      label: camera.label,
      deviceId: camera.deviceId,
    }))
  );

  // Prefer an explicitly labelled standard/main rear lens.
  // Do not mistake ultra-wide, macro or telephoto for the main lens.
  const excludedLens = /ultra.?wide|ultrawide|macro|telephoto|front|selfie/i;
  const preferredLens = /\b(main|wide|1x|standard|back|rear)\b/i;

  const selectedCamera = cameras.find(
    (camera) =>
      preferredLens.test(camera.label) &&
      !excludedLens.test(camera.label)
  );

  // Exact device selection works when the browser exposes separate lenses.
  // Otherwise request the rear-facing camera at the highest ideal resolution.
  const videoConstraints: MediaTrackConstraints = selectedCamera
    ? {
        deviceId: { exact: selectedCamera.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      }
    : {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      };

  const stream = await devices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });

  const track = stream.getVideoTracks()[0];

  if (track) {
    console.log('Selected camera:', track.label);
    console.log('Actual camera settings:', track.getSettings());
  }

  return stream;
}

export default function App() {
  const [events, setEvents] = useState<Entry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORE) || '[]') as Entry[];
    } catch {
      return [];
    }
  });

  const [plate, setPlate] = useState('');
  const [query, setQuery] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    'Start the camera to scan bus plates automatically.'
  );
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'ALL' | Direction>('ALL');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const cameraOnRef = useRef(false);
  const lastConfirmedRef = useRef<Record<string, number>>({});
  const recognizedRef = useRef<
    Record<string, { count: number; time: number }>
  >({});

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(events));
  }, [events]);

  const latestByPlate = useMemo(() => {
    const map = new Map<string, Entry>();

    for (const event of [...events].sort((a, b) =>
      a.time.localeCompare(b.time)
    )) {
      map.set(event.plate, event);
    }

    return map;
  }, [events]);

  const busesInside = [...latestByPlate.values()].filter(
    (event) => event.direction === 'IN'
  ).length;

  const todayEvents = events.filter(
    (event) =>
      new Date(event.time).toDateString() === new Date().toDateString()
  );

  const filtered = [...events]
    .filter(
      (event) =>
        (filter === 'ALL' || event.direction === filter) &&
        (!cleanPlate(query) || event.plate.includes(cleanPlate(query)))
    )
    .sort((a, b) => b.time.localeCompare(a.time));

  useEffect(() => {
    if (!cameraOn) return;

    const video = videoRef.current;
    const stream = streamRef.current;

    if (!video || !stream) return;

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    video.play().catch(() => {
      setError('Video playback failed. Stop and restart the camera.');
    });
  }, [cameraOn]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startCamera() {
    setError('');

    try {
      const stream = await getMainRearCameraStream();

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      cameraOnRef.current = true;
      setCameraOn(true);

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();

      setMessage(
        `Camera ready: ${settings?.width ?? '?'} × ${settings?.height ?? '?'} pixels.`
      );
    } catch (cameraError) {
      console.error('Camera startup failed:', cameraError);
      setError(
        'Camera unavailable. Allow camera permission, close other camera apps and try again.'
      );
    }
  }

  function stopCamera() {
    cameraOnRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraOn(false);
    setMessage('Camera stopped.');
  }

  const recordPlate = useCallback(
    (raw: string, source: 'camera' | 'manual' = 'camera') => {
      const number = cleanPlate(raw);

      if (number.length < 5 || !/[A-Z]/.test(number) || !/\d/.test(number)) {
        return;
      }

      const last = latestByPlate.get(number);
      const direction: Direction = last?.direction === 'IN' ? 'OUT' : 'IN';
      const now = new Date().toISOString();

      const entry: Entry = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        plate: number,
        direction,
        time: now,
        source,
      };

      setEvents((old) => [entry, ...old]);
      setPlate(number);
      setError('');
      setMessage(`${number} recorded ${direction} at ${formatTime(now)}.`);
    },
    [latestByPlate]
  );

  async function scanFrame() {
    const video = videoRef.current;

    if (
      busyRef.current ||
      !cameraOnRef.current ||
      !video?.videoWidth ||
      video.readyState < 2
    ) {
      return;
    }

    busyRef.current = true;
    setBusy(true);

    try {
      // Use the actual video frame dimensions, not the CSS preview size.
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');
      if (!context) return;

      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const result = await Tesseract.recognize(canvas, 'eng');

      if (!cameraOnRef.current) return;

      const candidates = result.data.text
        .toUpperCase()
        .split(/[\s\n]+/)
        .map(cleanPlate)
        .filter(
          (value) =>
            value.length >= 7 && /[A-Z]/.test(value) && /\d/.test(value)
        );

      const found = candidates.sort((a, b) => b.length - a.length)[0];
      const now = Date.now();

      if (!found) {
        setMessage('Scanning… keep the plate close, clear and well lit.');
        return;
      }

      setPlate(found);

      const previous = recognizedRef.current[found];
      const count =
        previous && now - previous.time < 10000 ? previous.count + 1 : 1;

      recognizedRef.current[found] = { count, time: now };

      if (count < 2) {
        setMessage(`Detected ${found}. Confirming with another scan…`);
        return;
      }

      const lastRecordTime = lastConfirmedRef.current[found] || 0;

      if (now - lastRecordTime < CONFIRM_MS) {
        setMessage(`${found} is still in view. Waiting before the next record.`);
        return;
      }

      recordPlate(found, 'camera');
      lastConfirmedRef.current[found] = now;
      recognizedRef.current[found] = { count: 0, time: now };
    } catch (scanError) {
      console.error('OCR scan failed:', scanError);
      setMessage('Could not read the plate. Improve lighting or enter it manually.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!cameraOn) return;

    const timer = window.setInterval(() => {
      void scanFrame();
    }, SCAN_MS);

    return () => window.clearInterval(timer);
  }, [cameraOn]);

  async function readImage(image: Blob | string) {
    setBusy(true);
    setError('');
    setMessage('Reading image…');

    try {
      const result = await Tesseract.recognize(image, 'eng');

      const candidates = result.data.text
        .toUpperCase()
        .split(/[\s\n]+/)
        .map(cleanPlate)
        .filter(
          (value) =>
            value.length >= 7 && /[A-Z]/.test(value) && /\d/.test(value)
        );

      const found = candidates.sort((a, b) => b.length - a.length)[0];

      if (found) {
        setPlate(found);
        setMessage(`Possible plate: ${found}. Verify it before recording.`);
      } else {
        setMessage('No plate found. Try a clearer image or type the number manually.');
      }
    } catch (imageError) {
      console.error('Image OCR failed:', imageError);
      setError('Unable to read this image.');
    } finally {
      setBusy(false);
    }
  }

  function manualRecord(direction?: Direction) {
    const number = cleanPlate(plate);

    if (number.length < 5 || !/[A-Z]/.test(number) || !/\d/.test(number)) {
      setError('Enter a valid plate containing letters and numbers.');
      return;
    }

    if (!direction) {
      recordPlate(number, 'manual');
      return;
    }

    const event: Entry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      plate: number,
      direction,
      time: new Date().toISOString(),
      source: 'manual',
    };

    setEvents((old) => [event, ...old]);
    setMessage(`${number} recorded ${direction} at ${formatTime(event.time)}.`);
    setError('');
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
        row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')
      )
      .join('\n');

    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    );

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'bus-gate-records.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function removeAll() {
    if (confirm('Delete all bus gate records stored in this browser?')) {
      setEvents([]);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><BusFront size={23} /></div>
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
            <p>Scan a bus number plate and record its arrival or departure time.</p>
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
            <div className="stat-icon blue"><BusFront size={20} /></div>
            <div><span>Buses currently inside</span><strong>{busesInside}</strong><small>Based on latest movement</small></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green"><ArrowDownToLine size={20} /></div>
            <div><span>Today's arrivals</span><strong>{todayEvents.filter((event) => event.direction === 'IN').length}</strong><small>Recorded today</small></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon amber"><ArrowUpFromLine size={20} /></div>
            <div><span>Today's departures</span><strong>{todayEvents.filter((event) => event.direction === 'OUT').length}</strong><small>Recorded today</small></div>
          </div>
        </section>

        <section className="workspace">
          <div className="panel scanner-panel">
            <div className="panel-heading">
              <div><div className="eyebrow">CAMERA / IMAGE OCR</div><h2>Number plate scanner</h2></div>
              <span className={`status-pill ${cameraOn ? 'active' : ''}`}><span />{cameraOn ? 'CAMERA ON' : 'READY'}</span>
            </div>

            <div className="camera-stage">
              {cameraOn ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    backgroundColor: '#050a12',
                  }}
                />
              ) : (
                <div className="camera-placeholder">
                  <div className="scan-frame"><ScanLine size={38} /></div>
                  <strong>Position the number plate</strong>
                  <span>Keep the plate level, clear and well lit.</span>
                </div>
              )}
              {cameraOn && <div className="camera-overlay"><span>ALIGN PLATE INSIDE FRAME</span></div>}
              {busy && <div className="busy-overlay"><RefreshCw className="spin" size={26} /><span>Reading number plate…</span></div>}
            </div>

            <div className="camera-actions">
              <button className="button secondary" onClick={cameraOn ? stopCamera : startCamera}>
                {cameraOn ? <CameraOff size={17} /> : <Camera size={17} />}
                {cameraOn ? 'Stop camera' : 'Start camera'}
              </button>
              <button className="button primary" onClick={() => void scanFrame()} disabled={!cameraOn || busy}>
                <ScanLine size={17} /> Scan now
              </button>
            </div>

            <div className="or-divider"><span>OR UPLOAD A PHOTO</span></div>
            <button className="upload-button" onClick={() => fileRef.current?.click()} disabled={busy}>Choose plate image</button>
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
            <div className="notice"><AlertCircle size={16} /><span>Automatic OCR is a best-effort reader. Verify number plates before using official records.</span></div>
          </div>

          <div className="panel record-panel">
            <div className="eyebrow">GATE LOG</div>
            <h2>Record bus movement</h2>
            <p className="subtext">Camera detections record movement automatically. Manual entry is available as a fallback.</p>

            <label className="field-label" htmlFor="plate">BUS NUMBER PLATE</label>
            <div className="plate-input-wrap">
              <div className="india-tag">IND</div>
              <input
                id="plate"
                value={plate}
                onChange={(event) => setPlate(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') manualRecord();
                }}
                placeholder="e.g. TN01AB1234"
                maxLength={14}
              />
              <button className="clear-input" onClick={() => setPlate('')} aria-label="Clear plate"><X size={16} /></button>
            </div>
            <div className="input-hint">Detected numbers can be corrected before manual recording.</div>

            {plate && (
              <div className="detected-card">
                <div className="detected-check"><CheckCircle2 size={17} /></div>
                <div><span>PLATE TO RECORD</span><strong>{cleanPlate(plate)}</strong></div>
                <button className="edit-link" onClick={() => setPlate(cleanPlate(plate))}>Normalize</button>
              </div>
            )}

            {error && <div className="error-message"><AlertCircle size={16} />{error}</div>}

            <div className="record-buttons">
              <button className="button arrival" onClick={() => manualRecord('IN')}>
                <ArrowDownToLine size={18} /><span>Record IN<small>Manual arrival record</small></span>
              </button>
              <button className="button departure" onClick={() => manualRecord('OUT')}>
                <ArrowUpFromLine size={18} /><span>Record OUT<small>Manual departure record</small></span>
              </button>
            </div>

            <div className="message-line"><CheckCircle2 size={15} />{message}</div>
            <div className="rule-note"><strong>Automatic rule:</strong> First confirmed plate detection records IN. The next confirmed visit records OUT, then alternates. A camera cannot determine actual direction of travel by itself.</div>
          </div>
        </section>

        <section className="panel log-panel">
          <div className="log-header">
            <div><div className="eyebrow">MOVEMENT HISTORY</div><h2>Recent gate records <span className="count-badge">{filtered.length}</span></h2></div>
            <button className="button secondary export-btn" onClick={exportCsv}><Download size={16} />Export CSV</button>
          </div>

          <div className="toolbar">
            <div className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plate number…" /></div>
            <div className="filter-group">
              {(['ALL', 'IN', 'OUT'] as const).map((value) => (
                <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>
                  {value === 'ALL' ? 'All records' : value === 'IN' ? 'Arrivals' : 'Departures'}
                </button>
              ))}
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead><tr><th>BUS PLATE</th><th>MOVEMENT</th><th>DATE</th><th>TIME</th><th>METHOD</th></tr></thead>
              <tbody>
                {filtered.slice(0, 100).map((event) => (
                  <tr key={event.id}>
                    <td><span className="plate-badge">{event.plate}</span></td>
                    <td><span className={`direction ${event.direction.toLowerCase()}`}>{event.direction === 'IN' ? <ArrowDownToLine size={14} /> : <ArrowUpFromLine size={14} />}{event.direction}</span></td>
                    <td>{formatDate(event.time)}</td>
                    <td className="time-cell">{formatTime(event.time)}</td>
                    <td><span className="method-label">{event.source === 'camera' ? 'Camera / OCR' : 'Manual'}</span></td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="empty-state">
                    <div className="empty-icon"><BusFront size={24} /></div>
                    <strong>No records yet</strong>
                    <span>Scan a plate or enter one manually to create the first record.</span>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="table-footer">
            <span>Showing {Math.min(filtered.length, 100)} of {filtered.length} records · Stored in this browser</span>
            <button className="text-danger" onClick={removeAll}><Trash2 size={14} />Clear records</button>
          </div>
        </section>

        <footer>GateFlow Bus Tracker <span>•</span> Browser-based prototype <span>•</span> Records stored locally on this device</footer>
      </main>
    </div>
  );
}
