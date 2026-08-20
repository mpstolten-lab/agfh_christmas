// Zeitstempel-Tool - grobe Schätzung der Lyrics-Timestamps, Feinschliff per Drag auf der Wellenform.

// ---- DOM-Referenzen ----
const titleInput = document.getElementById("titleInput");
const audioFileInput = document.getElementById("audioFileInput");
const audioPathInput = document.getElementById("audioPathInput");
const imagePathInput = document.getElementById("imagePathInput");
const introInput = document.getElementById("introInput");
const outroInput = document.getElementById("outroInput");
const lyricsInput = document.getElementById("lyricsInput");

const playBtn = document.getElementById("playBtn");
const timeReadout = document.getElementById("timeReadout");
const reestimateBtn = document.getElementById("reestimateBtn");

const waveformContainer = document.getElementById("waveformContainer");
const waveformCanvas = document.getElementById("waveformCanvas");
const markerLayer = document.getElementById("markerLayer");
const playhead = document.getElementById("playhead");
const emptyState = document.getElementById("emptyState");
const lineListEl = document.getElementById("lineList");

const songFileNameEl = document.getElementById("songFileName");
const songJsonOutput = document.getElementById("songJsonOutput");
const playlistJsonOutput = document.getElementById("playlistJsonOutput");
const copySongJsonBtn = document.getElementById("copySongJsonBtn");
const downloadSongJsonBtn = document.getElementById("downloadSongJsonBtn");
const copyPlaylistJsonBtn = document.getElementById("copyPlaylistJsonBtn");

// ---- Zustand ----
const audioEl = new Audio();
let audioBuffer = null; // decodierte PCM-Daten, für Wellenform + Dauer
let songDuration = 0; // "Songende" - editierbar, bestimmt duration im playlist.json
let pixelsPerSecond = 0;
let linesState = []; // [{ text, start, touched }]
let rafId = null;

// ---- Hilfsfunktionen ----
function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseLyrics() {
  return lyricsInput.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---- Zeitschätzung ----
// Verteilt Zeilen proportional zu ihrer Zeichenlänge über den verfügbaren
// Zeitraum. Manuell verschobene ("touched") Zeilen bleiben als Anker fest;
// die übrigen Zeilen werden innerhalb der Lücken zwischen den Ankern neu verteilt.
function reestimate() {
  const n = linesState.length;
  if (n === 0 || !audioBuffer) return;

  const intro = Number(introInput.value) || 0;
  const outro = Number(outroInput.value) || 0;
  const endTime = Math.max(songDuration - outro, intro);

  const anchors = [{ index: -1, time: intro }];
  linesState.forEach((l, i) => {
    if (l.touched) anchors.push({ index: i, time: l.start });
  });
  anchors.push({ index: n, time: endTime });
  anchors.sort((a, b) => a.index - b.index);

  for (let a = 0; a < anchors.length - 1; a++) {
    const from = anchors[a];
    const to = anchors[a + 1];
    const gapIndices = [];
    for (let i = from.index + 1; i < to.index; i++) gapIndices.push(i);
    if (!gapIndices.length) continue;

    const weights = gapIndices.map((i) => Math.max(linesState[i].text.length, 1));
    const totalWeight = weights.reduce((x, y) => x + y, 0);
    // Virtueller Puffer-Slot am Ende, damit die letzte Zeile nicht exakt auf
    // dem nächsten Anker landet (nur relevant, wenn "to" ein Anker ist).
    const bufferedTotal = totalWeight + totalWeight / gapIndices.length;
    const span = Math.max(to.time - from.time, 0);

    let cum = 0;
    gapIndices.forEach((i, k) => {
      cum += weights[k];
      linesState[i].start = round1(from.time + (cum / bufferedTotal) * span);
    });
  }

  renderMarkers();
  renderLineList();
  renderOutput();
}

// Setzt alle "touched"-Flags zurück und schätzt komplett neu
function reestimateAll() {
  linesState.forEach((l) => (l.touched = false));
  reestimate();
}

// Übernimmt den aktuellen Liedtext in linesState, behält Zeiten für
// unveränderte Zeilen bei neuem Index bei
function syncLinesFromTextarea() {
  const texts = parseLyrics();
  const prev = linesState;
  linesState = texts.map((text, i) => {
    if (prev[i] && prev[i].text === text) return prev[i];
    return { text, start: 0, touched: false };
  });
  reestimate();
}

// ---- Wellenform ----
function drawWaveform() {
  if (!audioBuffer) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = waveformContainer.getBoundingClientRect();
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  pixelsPerSecond = rect.width / audioBuffer.duration;

  const ctx = waveformCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const data = audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(data.length / rect.width));
  const mid = rect.height / 2;

  ctx.fillStyle = "#4f8fc9";
  for (let x = 0; x < rect.width; x++) {
    const start = x * samplesPerPixel;
    let min = 0;
    let max = 0;
    for (let i = 0; i < samplesPerPixel; i++) {
      const v = data[start + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid * 0.9;
    const y2 = mid + max * mid * 0.9;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function timeToX(t) {
  return t * pixelsPerSecond;
}

function xToTime(x) {
  return clamp(x / pixelsPerSecond, 0, audioBuffer ? audioBuffer.duration : 0);
}

// ---- Marker (Zeilen + Songende) rendern & Drag-Interaktion ----
function renderMarkers() {
  markerLayer.innerHTML = "";
  if (!audioBuffer) return;

  linesState.forEach((line, i) => {
    const marker = document.createElement("div");
    marker.className = "marker" + (line.touched ? " touched" : "");
    marker.dataset.index = String(i + 1);
    marker.style.left = `${timeToX(line.start)}px`;
    marker.title = `${line.text} (${formatTime(line.start)})`;
    attachLineMarkerDrag(marker, i);
    markerLayer.appendChild(marker);
  });

  const durationMarker = document.createElement("div");
  durationMarker.className = "marker duration-marker";
  durationMarker.style.left = `${timeToX(songDuration)}px`;
  attachDurationMarkerDrag(durationMarker);
  markerLayer.appendChild(durationMarker);
}

function attachLineMarkerDrag(marker, index) {
  marker.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    marker.setPointerCapture(e.pointerId);

    const onMove = (moveEvt) => {
      const rect = waveformContainer.getBoundingClientRect();
      const t = xToTime(moveEvt.clientX - rect.left);
      linesState[index].start = round1(t);
      linesState[index].touched = true;
      marker.style.left = `${timeToX(t)}px`;
      marker.classList.add("touched");
      updateLineListRow(index);
      renderOutput();
    };

    const onUp = () => {
      marker.removeEventListener("pointermove", onMove);
      marker.removeEventListener("pointerup", onUp);
      reestimate(); // umliegende, nicht angefasste Zeilen neu verteilen
    };

    marker.addEventListener("pointermove", onMove);
    marker.addEventListener("pointerup", onUp);
  });
}

function attachDurationMarkerDrag(marker) {
  marker.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    marker.setPointerCapture(e.pointerId);

    const onMove = (moveEvt) => {
      const rect = waveformContainer.getBoundingClientRect();
      const t = xToTime(moveEvt.clientX - rect.left);
      songDuration = round1(clamp(t, 1, audioBuffer.duration));
      marker.style.left = `${timeToX(songDuration)}px`;
      renderOutput();
    };

    const onUp = () => {
      marker.removeEventListener("pointermove", onMove);
      marker.removeEventListener("pointerup", onUp);
      reestimate();
    };

    marker.addEventListener("pointermove", onMove);
    marker.addEventListener("pointerup", onUp);
  });
}

// Klick auf die Wellenform (außerhalb eines Markers) spult
waveformContainer.addEventListener("pointerdown", (e) => {
  if (e.target !== waveformCanvas) return;
  if (!audioBuffer) return;
  const rect = waveformContainer.getBoundingClientRect();
  audioEl.currentTime = xToTime(e.clientX - rect.left);
});

// ---- Zeilenliste ----
function renderLineList() {
  lineListEl.innerHTML = "";
  linesState.forEach((line, i) => {
    const li = document.createElement("li");
    li.dataset.index = String(i);

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i + 1;

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = line.text;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(line.start);

    const nudge = document.createElement("span");
    nudge.className = "nudge";
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.addEventListener("click", () => nudgeLine(i, -0.1));
    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.addEventListener("click", () => nudgeLine(i, 0.1));
    nudge.append(minus, plus);

    const resetBtn = document.createElement("button");
    resetBtn.className = "resetBtn";
    resetBtn.textContent = "↺";
    resetBtn.title = "Zurücksetzen auf Schätzung";
    resetBtn.disabled = !line.touched;
    resetBtn.addEventListener("click", () => {
      linesState[i].touched = false;
      reestimate();
    });

    li.append(idx, text, time, nudge, resetBtn);
    li.addEventListener("click", (e) => {
      if (e.target.tagName === "BUTTON") return;
      audioEl.currentTime = line.start;
    });

    lineListEl.appendChild(li);
  });
}

function updateLineListRow(index) {
  const li = lineListEl.querySelector(`li[data-index="${index}"]`);
  if (!li) return;
  li.querySelector(".time").textContent = formatTime(linesState[index].start);
}

function nudgeLine(index, delta) {
  const line = linesState[index];
  line.start = round1(clamp(line.start + delta, 0, songDuration));
  line.touched = true;
  reestimate();
}

// ---- Output (JSON) ----
function renderOutput() {
  const title = titleInput.value.trim() || "Titel";
  const audioPath = audioPathInput.value.trim() || "audio/song.mp3";
  const imagePath = imagePathInput.value.trim() || "images/red_tree.jpg";
  const slug = slugify(title) || "song";

  songFileNameEl.textContent = `data/${slug}.json`;

  const songJson = {
    title,
    audio: `audio/${audioPath.replace(/^audio\//, "")}`,
    lines: linesState.map((l) => ({ text: l.text, start: l.start })),
  };
  songJsonOutput.textContent = JSON.stringify(songJson, null, 2);

  const playlistEntry = {
    title,
    file: `data/${slug}.json`,
    duration: Math.round(songDuration),
    image: `images/${imagePath.replace(/^images\//, "")}`,
  };
  playlistJsonOutput.textContent = JSON.stringify(playlistEntry, null, 2);
}

// ---- Playback ----
function togglePlay() {
  if (!audioBuffer) return;
  if (audioEl.paused) audioEl.play();
  else audioEl.pause();
}

function updatePlayhead() {
  if (audioBuffer) {
    playhead.style.left = `${timeToX(audioEl.currentTime)}px`;
    timeReadout.textContent = `${formatTime(audioEl.currentTime)} / ${formatTime(audioBuffer.duration)}`;
    highlightActiveLine();
  }
  rafId = requestAnimationFrame(updatePlayhead);
}

function highlightActiveLine() {
  const t = audioEl.currentTime;
  let activeIdx = -1;
  for (let i = 0; i < linesState.length; i++) {
    if (t >= linesState[i].start) activeIdx = i;
  }
  lineListEl.querySelectorAll("li.active").forEach((li) => li.classList.remove("active"));
  if (activeIdx >= 0) {
    const li = lineListEl.querySelector(`li[data-index="${activeIdx}"]`);
    if (li) li.classList.add("active");
  }
}

audioEl.addEventListener("play", () => (playBtn.textContent = "⏸"));
audioEl.addEventListener("pause", () => (playBtn.textContent = "▶"));
playBtn.addEventListener("click", togglePlay);

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = document.activeElement.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  e.preventDefault();
  togglePlay();
});

// ---- Datei-Handling ----
audioFileInput.addEventListener("change", async () => {
  const file = audioFileInput.files[0];
  if (!file) return;

  if (!audioPathInput.value.trim()) audioPathInput.value = file.name;
  if (!titleInput.value.trim()) {
    titleInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
  }

  audioEl.src = URL.createObjectURL(file);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  songDuration = round1(audioBuffer.duration);

  emptyState.style.display = "none";
  playBtn.disabled = false;
  reestimateBtn.disabled = false;

  drawWaveform();
  syncLinesFromTextarea();
});

window.addEventListener("resize", () => {
  if (audioBuffer) {
    drawWaveform();
    renderMarkers();
  }
});

// ---- Input-Listener ----
let lyricsDebounce = null;
lyricsInput.addEventListener("input", () => {
  clearTimeout(lyricsDebounce);
  lyricsDebounce = setTimeout(syncLinesFromTextarea, 300);
});

[titleInput, audioPathInput, imagePathInput].forEach((el) =>
  el.addEventListener("input", renderOutput),
);

[introInput, outroInput].forEach((el) => el.addEventListener("change", reestimate));

reestimateBtn.addEventListener("click", reestimateAll);

copySongJsonBtn.addEventListener("click", () => navigator.clipboard.writeText(songJsonOutput.textContent));
copyPlaylistJsonBtn.addEventListener("click", () => navigator.clipboard.writeText(playlistJsonOutput.textContent));

downloadSongJsonBtn.addEventListener("click", () => {
  const slug = slugify(titleInput.value.trim() || "song");
  const blob = new Blob([songJsonOutput.textContent], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- Start ----
renderOutput();
rafId = requestAnimationFrame(updatePlayhead);
