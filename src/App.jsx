import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const eventDate = new Date("August 07, 2026 14:55:00").getTime();
const GAP_SECONDS = 20;
const BASE_URL = import.meta.env.BASE_URL;

function App() {
  const [started, setStarted] = useState(false);                // Startbutton 
  const [countdownText, setCountdownText] = useState("");       //Countdown
  const [songs, setSongs] = useState([]);
  const [currentSongIndex, setCurrentSongIndex] = useState(0);
  const [songData, setSongData] = useState(null);               // geladene JSON des aktuellen Songs
  const [currentLine, setCurrentLine] = useState(-1);
  const [showEnd, setShowEnd] = useState(false);
  const [gapCountdown, setGapCountdown] = useState(null);       // null = keine Pause aktiv

  // references
  const audioRef = useRef(null);
  const scheduledStartRef = useRef(eventDate);
  const songsRef = useRef([]); 

  // 1. Load Song details and time
  const loadSong = useCallback(async (index) => {
    const list = songsRef.current;
    const response = await fetch(`${BASE_URL}${list[index].file}`);
    const data = await response.json();
    setSongData(data);
    setCurrentLine(-1);
    setGapCountdown(null);
  }, []);

  // 2. Loadplaylist an set starting time
  const loadPlaylist = useCallback(async () => {
    const response = await fetch(`${BASE_URL}data/playlist.json`);
    const playlist = await response.json();
    songsRef.current = playlist.songs;
    setSongs(playlist.songs);

    let scheduledStart = eventDate;
    let index = 0;
    const list = playlist.songs;


      //
    while (
      index < list.length - 1 &&
      Date.now() >= scheduledStart + (list[index].duration + GAP_SECONDS) * 1000
    ) {
      scheduledStart += (list[index].duration + GAP_SECONDS) * 1000;
      index++;
    }

    // if last song is over show endscreen
    if (Date.now() >= scheduledStart + list[index].duration * 1000) {
      setShowEnd(true);
      return;
    }

    scheduledStartRef.current = scheduledStart;
    setCurrentSongIndex(index);
    loadSong(index);
  }, [loadSong]);

  // Wird ausgelöst, sobald der Browser die Dauer der Audiodatei kennt
  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    const list = songsRef.current;
    const secondsIntoSong = Math.max(
      0,
      Math.min(
        (Date.now() - scheduledStartRef.current) / 1000,
        list[currentSongIndex].duration,
      ),
    );
    audio.currentTime = secondsIntoSong;
    audio.play();
  };

  // Show current line
  const handleTimeUpdate = () => {
    if (!songData) return;
    const t = audioRef.current.currentTime;
    const idx = songData.lines.findLastIndex((l) => t >= l.start);
    setCurrentLine(idx);
  };


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

  // 3. Countdown bis eventDate, nach Klick auf Start
  const handleStartClick = () => {
    setStarted(true);
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

  // visibilitychange: Resync nach Rückkehr aus dem Hintergrund
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
          songData?.image
            ? `${BASE_URL}${songData.image}`
            : `${BASE_URL}images/red_tree.jpg`
        }
        alt=""
      />

{/* shown when started is false, the ids are needed für CSS styling */}
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
      {countdownText && <div id="countdown">{countdownText}</div>}
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
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        controls
      />
    </div>
  );
}

export default App;
