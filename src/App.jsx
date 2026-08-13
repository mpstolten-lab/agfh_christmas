import { useState, useRef, useEffect, useCallback, memo } from "react";
import "./App.css";

const eventDate = new Date("August 13, 2026 12:26:00").getTime();
const GAP_SECONDS = 25;

const NUDGE_ON_SECONDS = 0.75;         // drift required to start a playbackRate correction
const NUDGE_OFF_SECONDS = 0.3;         // drift below which a running correction stops (hysteresis, avoids flip-flopping every tick)
const HARD_RESYNC_SECONDS = 3;         // threshold above which we jump straight to the expected position
const NUDGE_RATE_PER_SECOND = 0.03;    // playback rate adjustment per second of drift
const MAX_NUDGE_RATE = 0.06;           // cap so the adjustment stays unnoticeable
const RESYNC_INTERVAL_MS = 1000;       // how often the playback position is checked

const BASE_URL = import.meta.env.BASE_URL;

// Renders only the +/-1 lyric lines around the active one; memoized so that
// unrelated state changes elsewhere in App (countdown ticks, gap timer)
// don't force this list to be recomputed and re-diffed on every render.
const Lyrics = memo(function Lyrics({ lines, currentLine }) {
  return (
    <div id="lyrics">
      {lines.map((line, i) => {
        const visible = i >= currentLine - 1 && i <= currentLine + 1;
        if (!visible) return null;
        return (
          <div
            key={i}
            id={`line-${i}`}
            className="line active"
            style={{ opacity: i === currentLine ? 1 : 0.4 }}
          >
            {line.text}
          </div>
        );
      })}
    </div>
  );
});

function App() {
  const [started, setStarted] = useState(false);                // true once the start button was clicked
  const [countdownText, setCountdownText] = useState("");       // formatted countdown text until eventDate
  const [songs, setSongs] = useState([]);                       // full playlist, for the title list display
  const [currentSongIndex, setCurrentSongIndex] = useState(0);  // index of the song currently playing
  const [songData, setSongData] = useState(null);               // loaded JSON (lyrics/audio) of the current song
  const [currentLine, setCurrentLine] = useState(-1);            // index of the currently highlighted lyric line
  const [showEnd, setShowEnd] = useState(false);                // true once the playlist is finished
  const [gapCountdown, setGapCountdown] = useState(null);       // seconds left in the break; null = no break active

  // references
  const audioRef = useRef(null);                    // the <audio> DOM element
  const scheduledStartRef = useRef(eventDate);       // shared start time of the current song
  const songsRef = useRef([]);                       // playlist, kept in sync with `songs` for use in callbacks
  const isNudgingRef = useRef(false);                // whether a playbackRate correction is currently active (hysteresis)
  const lastRateRef = useRef(1);                     // last playbackRate we actually wrote, so we don't rewrite it every tick
  const gapIntervalRef = useRef(null);               // interval id of the currently running gap countdown, if any
  const wakeLockRef = useRef(null);                   // active Screen Wake Lock sentinel, if any

  // Keeps the screen from auto-locking, so the gap countdown/next song never has to fight standby; silently no-ops if unsupported
  const requestWakeLock = useCallback(async () => {
    try {
      wakeLockRef.current = await navigator.wakeLock?.request("screen");
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  // Stops a stale gap countdown left running from before a standby/reload resync
  const clearGapInterval = useCallback(() => {
    if (gapIntervalRef.current) {
      clearInterval(gapIntervalRef.current);
      gapIntervalRef.current = null;
    }
  }, []);

  // Fetches the data (lyrics/audio) for a song and resets line/gap state
  const loadSong = useCallback(async (index) => {
    clearGapInterval();
    const list = songsRef.current;
    const response = await fetch(`${BASE_URL}${list[index].file}`);
    const data = await response.json();
    setSongData(data);
    setCurrentLine(-1);
    setGapCountdown(null);
  }, [clearGapInterval]);

  // Counts down to the real timestamp `nextStart`, so it self-corrects after a standby gap
  const startGapCountdown = useCallback((nextIndex, nextStart) => {
    clearGapInterval();
    setCurrentSongIndex(nextIndex);

    const tick = () => {
      const remaining = Math.ceil((nextStart - Date.now()) / 1000);
      if (remaining <= 0) {
        clearGapInterval();
        setGapCountdown(null);
        scheduledStartRef.current = nextStart;
        loadSong(nextIndex);
      } else {
        setGapCountdown(remaining);
      }
    };

    tick();
    gapIntervalRef.current = setInterval(tick, 1000);
  }, [loadSong, clearGapInterval]);

  // Loads the playlist and figures out which song should be playing right now
  const loadPlaylist = useCallback(async () => {
    const response = await fetch(`${BASE_URL}data/playlist.json`);
    const playlist = await response.json();
    songsRef.current = playlist.songs;
    setSongs(playlist.songs);

    let scheduledStart = eventDate;
    let index = 0;
    const list = playlist.songs;

    // advance until we reach the song that should currently be playing
    while (
      index < list.length - 1 &&
      Date.now() >= scheduledStart + (list[index].duration + GAP_SECONDS) * 1000
    ) {
      scheduledStart += (list[index].duration + GAP_SECONDS) * 1000;
      index++;
    }

    const songEnd = scheduledStart + list[index].duration * 1000;

    // song's audio already over: either we're in the pause, or (if last song) the playlist is done
    if (Date.now() >= songEnd) {
      if (index < list.length - 1) {
        startGapCountdown(index + 1, songEnd + GAP_SECONDS * 1000);
        return;
      }
      setShowEnd(true);
      return;
    }

    scheduledStartRef.current = scheduledStart;
    setCurrentSongIndex(index);
    loadSong(index);
  }, [loadSong, startGapCountdown]);

  // Calculates where in the song we should be right now, based on the shared start time
  const getExpectedTime = useCallback(() => {
    const list = songsRef.current;
    const duration = list[currentSongIndex]?.duration ?? Infinity;
    return Math.max(
      0,
      Math.min((Date.now() - scheduledStartRef.current) / 1000, duration),
    );
  }, [currentSongIndex]);

  // Fires once the audio duration is known; jumps to the expected position and plays
  const handleLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    audio.currentTime = getExpectedTime();
    // the <audio> element is reused across songs, so a leftover nudge from
    // the previous song's resync would otherwise carry over
    audio.playbackRate = 1;
    lastRateRef.current = 1;
    isNudgingRef.current = false;
    audio.play();
  }, [getExpectedTime]);

  // Fires whenever playback (re)starts - including after a buffering stall.
  // Only hard-jump on large drift; small drift is left to the gentle
  // playbackRate nudge in the resync interval below. Otherwise a stall
  // caused by a slow connection triggers a jump into not-yet-buffered
  // territory, which stalls again, which jumps further - a runaway loop
  // that sounds like the audio suddenly speeding up.
  const handlePlaying = useCallback(() => {
    const audio = audioRef.current;
    const expected = getExpectedTime();
    if (Math.abs(audio.currentTime - expected) > HARD_RESYNC_SECONDS) {
      audio.currentTime = expected;
    }
  }, [getExpectedTime]);

  // Updates which lyric line is currently highlighted based on playback time
  const handleTimeUpdate = useCallback(() => {
    if (!songData) return;
    const t = audioRef.current.currentTime;
    const idx = songData.lines.findLastIndex((l) => t >= l.start);
    // only trigger a re-render when the highlighted line actually changes;
    // timeupdate fires several times a second, and re-rendering App on every
    // tick regardless competes with iOS's already tight main-thread budget
    setCurrentLine((prev) => (prev === idx ? prev : idx));
  }, [songData]);

  // re-sync
  useEffect(() => {
    if (!songData) return;

    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      const expected = getExpectedTime();
      const drift = audio.currentTime - expected; // >0: too far ahead, <0: behind
      const absDrift = Math.abs(drift);

      // hysteresis: once nudging, keep going until drift drops below the
      // lower (off) threshold, instead of the tight single threshold
      // flip-flopping the rate on/off every tick - iOS audibly glitches
      // on every playbackRate write, so we want as few writes as possible
      const onThreshold = isNudgingRef.current ? NUDGE_OFF_SECONDS : NUDGE_ON_SECONDS;
      isNudgingRef.current = absDrift > onThreshold;

      const targetRate = isNudgingRef.current
        ? drift > 0
          ? 1 - Math.min(absDrift * NUDGE_RATE_PER_SECOND, MAX_NUDGE_RATE)
          : 1 + Math.min(absDrift * NUDGE_RATE_PER_SECOND, MAX_NUDGE_RATE)
        : 1;

      if (Math.abs(targetRate - lastRateRef.current) > 0.005) {
        audio.playbackRate = targetRate;
        lastRateRef.current = targetRate;
      }
    }, RESYNC_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [songData, getExpectedTime]);


  // starts the gap countdown, then loads the next song or shows the end screen
  const handleEnded = useCallback(() => {
    const next = currentSongIndex + 1;
    const list = songsRef.current;

    if (next < list.length) {
      setSongData(null);
      const nextStart =
        scheduledStartRef.current +
        list[currentSongIndex].duration * 1000 +
        GAP_SECONDS * 1000;
      startGapCountdown(next, nextStart);
    } else {
      setSongData(null);
      setShowEnd(true);
    }
  }, [currentSongIndex, startGapCountdown]);

  // Runs the countdown to eventDate after clicking Start
  const handleStartClick = useCallback(() => {
    setStarted(true);
    requestWakeLock();

    // Load the playlist already now, just to display the titles during the countdown
    fetch(`${BASE_URL}data/playlist.json`)
      .then((response) => response.json())
      .then((playlist) => setSongs(playlist.songs));

    const x = setInterval(() => {
      const distance = eventDate - Date.now();
      const days = Math.floor(distance / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
      );
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);
      setCountdownText(`${days}d ${hours}h ${minutes}m ${seconds}s`);

      if (distance <= 0) {
        clearInterval(x);
        setCountdownText("");
        loadPlaylist();
      }
    }, 1000);
  }, [loadPlaylist, requestWakeLock]);

  // Re-syncs playback and re-acquires the wake lock when the tab returns from the background
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        requestWakeLock();
        if (songsRef.current.length) loadPlaylist();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [loadPlaylist, requestWakeLock]);

  return (
    <div id="container">
      <img
        id="firstpicture"
        src={
          songs[currentSongIndex]?.image
            ? `${BASE_URL}${songs[currentSongIndex].image}`
            : `${BASE_URL}images/red_tree.jpg`
        }
        alt=""
      />

{/* shown when started is false, the ids are needed for CSS styling */}
      {!started && (
        <div id="start_screen">
          <img
            id="agfh_logo"
            src={`${BASE_URL}images/agfh_logo.png`}
            alt="AGFH Logo"
          />
          <p id="welcome_text">Willkommen zum Weihnachtssingen!</p>
          <button id="startbutton" onClick={handleStartClick}>
            Bereit
          </button>
        </div>
      )}

{/* Gap countdown */}
      {countdownText && (
        <>
          <div id="countdown">{countdownText}</div>
          {songs.length > 0 && (
            <>
              <h2 className="playlist_heading">Programm</h2>
              <div id="playlist_preview">
                <ol>
                  {songs.map((song) => (
                    <li key={song.file}>{song.title}</li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </>
      )}
      {gapCountdown != null && (
        <>
          <h2 id="title"> Es folgt: {songs[currentSongIndex]?.title}</h2>
          <br></br>
          <div id="countdown">Lied in {gapCountdown}s</div>
        </>
      )}

      {/* Display of song data */}
      {songData && (
        <>
          <h2 id="title">{songData.title}</h2>
          <Lyrics lines={songData.lines} currentLine={currentLine} />
        </>
      )}

      {/* end component */}
      {showEnd && <div id="end">Vielen Dank fürs Mitsingen!</div>}

      {/* audio component */}
      <audio
        ref={audioRef}
        src={songData?.audio ? `${BASE_URL}${songData.audio}` : undefined}
        preload="auto"
        onLoadedMetadata={handleLoadedMetadata}
        onPlaying={handlePlaying}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        controls
      />
    </div>
  );
}

export default App;
