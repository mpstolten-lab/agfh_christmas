import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const eventDate = new Date("August 13, 2026 08:32:00").getTime();
const GAP_SECONDS = 25;

const SOFT_DRIFT_SECONDS = 0.3;        // threshold above which playback rate is gently adjusted
const NUDGE_RATE_PER_SECOND = 0.03;    // playback rate adjustment per second of drift
const MAX_NUDGE_RATE = 0.06;           // cap so the adjustment stays unnoticeable
const RESYNC_INTERVAL_MS = 1000;       // how often the playback position is checked

const BASE_URL = import.meta.env.BASE_URL;

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

  // Fetches the data (lyrics/audio) for a song and resets line/gap state
  const loadSong = useCallback(async (index) => {
    const list = songsRef.current;
    const response = await fetch(`${BASE_URL}${list[index].file}`);
    const data = await response.json();
    setSongData(data);
    setCurrentLine(-1);
    setGapCountdown(null);
  }, []);

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

    // if the last song is already over, show the end screen
    if (Date.now() >= scheduledStart + list[index].duration * 1000) {
      setShowEnd(true);
      return;
    }

    scheduledStartRef.current = scheduledStart;
    setCurrentSongIndex(index);
    loadSong(index);
  }, [loadSong]);

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
  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    audio.currentTime = getExpectedTime();
    audio.play();
  };

  // Fires once audio is actually playing; re-adjusts currentTime 
  const handlePlaying = () => {
    const audio = audioRef.current;
    const expected = getExpectedTime();
    if (Math.abs(audio.currentTime - expected) > SOFT_DRIFT_SECONDS) {
      audio.currentTime = expected;
    }
  };

  // Updates which lyric line is currently highlighted based on playback time
  const handleTimeUpdate = () => {
    if (!songData) return;
    const t = audioRef.current.currentTime;
    const idx = songData.lines.findLastIndex((l) => t >= l.start);
    setCurrentLine(idx);
  };

  // re-sync
  useEffect(() => {
    if (!songData) return;

    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      const expected = getExpectedTime();
      const drift = audio.currentTime - expected; // >0: too far ahead, <0: behind

      if (Math.abs(drift) > SOFT_DRIFT_SECONDS) {
        const nudge = Math.min(Math.abs(drift) * NUDGE_RATE_PER_SECOND, MAX_NUDGE_RATE);
        audio.playbackRate = drift > 0 ? 1 - nudge : 1 + nudge;
      } else {
        audio.playbackRate = 1;
      }
    }, RESYNC_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [songData, getExpectedTime]);


  // starts the gap countdown, then loads the next song or shows the end screen
  const handleEnded = () => {
    const next = currentSongIndex + 1;
    const list = songsRef.current;

    if (next < list.length) {
      setSongData(null); 
      setCurrentSongIndex(next);

      let count = GAP_SECONDS;
      setGapCountdown(count);
      const puffer = setInterval(() => {
        count -= 1;
        setGapCountdown(count);
        if (count <= 0) {
          clearInterval(puffer);
          setGapCountdown(null);

          scheduledStartRef.current = Date.now();
          loadSong(next);
        }
      }, 1000);
    } else {
      setSongData(null);
      setShowEnd(true);
    }
  };

  // Runs the countdown to eventDate after clicking Start
  const handleStartClick = () => {
    setStarted(true);

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
  };

  // Re-syncs playback when the tab returns from the background
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && songsRef.current.length) {
        loadPlaylist();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [loadPlaylist]);

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
          <div id="lyrics">
            {songData.lines.map((line, i) => {
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
        </>
      )}

      {/* end component */}
      {showEnd && <div id="end">Vielen Dank fürs Mitsingen!</div>}

      {/* audio component */}
      <audio
        ref={audioRef}
        src={songData?.audio ? `${BASE_URL}${songData.audio}` : undefined}
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
