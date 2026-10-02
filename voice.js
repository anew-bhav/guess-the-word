/**
 * Design Chain — voice input for AR mode.
 *
 * Small, self-contained interface mirroring face.js's shape: supported(),
 * start(), stop(), onResult(callback), onError(callback). Nothing else in
 * the app reaches into this file's internals — ui.js decides what to do
 * with a recognized phrase or an error; this module only wraps the
 * browser's SpeechRecognition API and keeps it listening continuously.
 *
 * Only used while AR mode is active: when the camera is on, the player
 * speaks their answer instead of typing it. Typing remains the only input
 * method outside AR mode, and is also the automatic fallback inside AR mode
 * if speech recognition isn't supported in this browser or the player
 * denies microphone access — ui.js re-shows the text input bar in both
 * cases. Nothing here ever throws synchronously; supported() lets a caller
 * check first, and start() reports failures only through onError(),
 * consistent with how face.js reports camera failures through a rejected
 * promise instead of a thrown error.
 *
 * onResult(callback) delivers the final recognized transcript (a plain
 * string, e.g. "drop shadow") for each phrase the player finishes saying —
 * this is the one that actually gets judged right or wrong.
 *
 * onInterimResult(callback) delivers the browser's best-guess-so-far
 * transcript *while the player is still talking*, updated repeatedly before
 * any final result lands. Never used for scoring — only for letting ui.js
 * preview letters live in the slots, so the player gets some visible
 * response immediately instead of a silent wait (originally omitted
 * entirely, which read as "no feedback on what is being listened" and made
 * the real decision delay feel even longer than it is).
 *
 * onListeningChange(callback) delivers a plain `true`/`false`: true once a
 * session has genuinely confirmed it started (the browser's own `onstart`
 * fired — not just "we called start()"), false the moment it stops for any
 * reason (ends, errors out, is intentionally stopped). This exists because
 * reacquiring the microphone can take a long time in practice — observed on
 * a real iPhone taking ~20 seconds to recover after the tab was
 * backgrounded, with a `audio-capture` error the whole time — and until
 * now ui.js had no way to know "we're still waiting," only "we asked it
 * to start." ui.js uses this to pause the round timer and show a
 * "Reconnecting microphone…" message for exactly as long as this stays
 * false, instead of letting the timer run blind through a gap the player
 * has no way to do anything about.
 *
 * Watchdog: a real-world SpeechRecognition session can silently stop
 * producing anything — no result, no error, no `onend` — and just sit
 * there dead for the rest of the game ("hanging in the middle", per a
 * real-device report). Relying on `onend` alone to trigger a restart
 * doesn't help when `onend` itself never fires. A periodic check instead
 * tracks how long it's been since any sign of life (a session starting, a
 * result, or the browser detecting speech/sound at all) and force-tears-down
 * and restarts the recognizer if that gap gets too long — independent of
 * whether the dead session ever reports its own death.
 */
const Voice = (() => {
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const WATCHDOG_CHECK_MS = 2000;
  // Every (re)start of the recognizer plays an audible system sound in
  // Chrome (the same start/stop cue used by Google's own voice features) —
  // there's no JS API to suppress it. A too-short timeout here means a
  // player just quietly thinking for a bit gets treated as "the session
  // died," forcing an unnecessary, audible restart — reported as "clicking
  // sound... quite frustrating." 20s was chosen to stay comfortably under a
  // round's 30s timer while rarely, if ever, firing during normal thinking
  // pauses — this still catches genuinely dead sessions, just less eagerly.
  const WATCHDOG_TIMEOUT_MS = 20000;

  let recognition = null;
  let listening = false; // true while we intend to keep listening (drives auto-restart)
  let resultCallbacks = [];
  let interimResultCallbacks = [];
  let errorCallbacks = [];
  let listeningChangeCallbacks = [];
  let debugCallbacks = [];
  let lastActivityAt = 0;
  let watchdogId = null;
  let sessionId = 0; // bumped on every (re)start, so a stale restart timer can't act on a session that's already gone

  function supported() {
    return !!RecognitionCtor;
  }

  function onResult(callback) {
    resultCallbacks.push(callback);
    return () => {
      resultCallbacks = resultCallbacks.filter((cb) => cb !== callback);
    };
  }

  function onInterimResult(callback) {
    interimResultCallbacks.push(callback);
    return () => {
      interimResultCallbacks = interimResultCallbacks.filter((cb) => cb !== callback);
    };
  }

  function onError(callback) {
    errorCallbacks.push(callback);
    return () => {
      errorCallbacks = errorCallbacks.filter((cb) => cb !== callback);
    };
  }

  function onListeningChange(callback) {
    listeningChangeCallbacks.push(callback);
    return () => {
      listeningChangeCallbacks = listeningChangeCallbacks.filter((cb) => cb !== callback);
    };
  }

  function emitResult(transcript) {
    resultCallbacks.forEach((cb) => {
      try {
        cb(transcript);
      } catch (err) {
        console.error("Voice: onResult callback threw", err);
      }
    });
  }

  function emitInterimResult(transcript) {
    interimResultCallbacks.forEach((cb) => {
      try {
        cb(transcript);
      } catch (err) {
        console.error("Voice: onInterimResult callback threw", err);
      }
    });
  }

  // Debugging only — a raw feed of every lifecycle signal the recognizer
  // produces (session start/end, speech/sound starting and stopping,
  // interim and final transcripts, errors, forced restarts), each as
  // { type, detail }. Timestamps aren't attached here — ui.js stamps every
  // line (including its own, non-voice "round" markers) against one shared
  // clock at log time, so everything lines up on a single timeline
  // regardless of source. Nothing in the game reads this normally; ui.js
  // only wires up a visible log for it behind an explicit debug flag.
  function onDebugEvent(callback) {
    debugCallbacks.push(callback);
    return () => {
      debugCallbacks = debugCallbacks.filter((cb) => cb !== callback);
    };
  }

  function emitDebugEvent(type, detail) {
    if (!debugCallbacks.length) return; // skip building event objects when nobody's listening
    const event = { type, detail };
    debugCallbacks.forEach((cb) => {
      try {
        cb(event);
      } catch (err) {
        console.error("Voice: onDebugEvent callback threw", err);
      }
    });
  }

  function emitError(error) {
    errorCallbacks.forEach((cb) => {
      try {
        cb(error);
      } catch (err) {
        console.error("Voice: onError callback threw", err);
      }
    });
  }

  let isListeningNow = false; // only emits onListeningChange when this actually flips, so consumers never see redundant true/true or false/false
  function emitListeningChange(nextIsListening) {
    if (nextIsListening === isListeningNow) return;
    isListeningNow = nextIsListening;
    listeningChangeCallbacks.forEach((cb) => {
      try {
        cb(isListeningNow);
      } catch (err) {
        console.error("Voice: onListeningChange callback threw", err);
      }
    });
  }

  function noteActivity() {
    lastActivityAt = Date.now();
  }

  function createAndStart() {
    const mySession = ++sessionId;
    noteActivity();

    recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    // Interim results are still never surfaced to onResult() below (only a
    // final result is ever emitted) — this is purely to keep the underlying
    // session itself more continuously active. Several browsers end a
    // continuous session more eagerly when interimResults is off (e.g.
    // right after every final result rather than staying open), and every
    // such end-then-restart cycle triggers the same audible system sound
    // the watchdog timeout above is also trying to minimize — so this is
    // a second lever on the same "fewer restarts, fewer clicks" goal.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      noteActivity();
      emitDebugEvent("start", { session: mySession });
      emitListeningChange(true);
    };
    // Fire on any detected sound/speech, not just a finished result — a
    // session that's actively hearing the player (even mid-utterance, before
    // a final transcript lands) isn't the "hung and dead" case the watchdog
    // is for. Not every engine fires both; either is enough to count.
    recognition.onspeechstart = () => {
      noteActivity();
      emitDebugEvent("speechstart");
    };
    recognition.onspeechend = () => emitDebugEvent("speechend");
    recognition.onsoundstart = () => {
      noteActivity();
      emitDebugEvent("soundstart");
    };
    recognition.onsoundend = () => emitDebugEvent("soundend");

    recognition.onresult = (event) => {
      noteActivity();
      const last = event.results[event.results.length - 1];
      if (!last) return;
      const transcript = last[0] ? last[0].transcript : "";
      if (!transcript.trim()) return;
      if (last.isFinal) {
        emitDebugEvent("result", transcript.trim());
        emitResult(transcript.trim());
      } else {
        emitDebugEvent("interim", transcript.trim());
        emitInterimResult(transcript.trim());
      }
    };

    recognition.onerror = (event) => {
      emitDebugEvent("error", event.error || "unknown");
      emitListeningChange(false);
      emitError(event.error || "unknown");
    };

    // Chrome in particular ends a "continuous" session on its own after a
    // stretch of silence, or right after delivering a final result —
    // restart automatically as long as we still intend to be listening.
    // stop() clears `listening` first, so an intentional stop never
    // triggers a restart here.
    recognition.onend = () => {
      emitDebugEvent("end", { session: mySession });
      emitListeningChange(false);
      if (listening && mySession === sessionId) {
        emitDebugEvent("auto-restart");
        try {
          createAndStart();
        } catch (err) {
          listening = false;
          stopWatchdog();
          emitError("restart-failed");
        }
      }
    };

    recognition.start();
  }

  // Tears down and restarts the recognizer from scratch when the watchdog
  // decides the current session is silently dead — distinct from onend's
  // own restart path above since this is the one case onend hasn't (and by
  // definition won't) fire on its own.
  function forceRestart() {
    const mySession = sessionId; // snapshot before tearing down, so the stale guard below still works
    emitDebugEvent("watchdog-restart", { session: mySession });
    emitListeningChange(false); // onend is nulled out below for this teardown, so it won't emit this on its own
    noteActivity(); // reset the clock immediately so a slow teardown doesn't trigger a second overlapping restart
    if (recognition) {
      recognition.onend = null; // this teardown is intentional, not a session we want auto-restarted twice
      try {
        recognition.stop();
      } catch {
        /* already stopped/dead — fine, we're replacing it regardless */
      }
      recognition = null;
    }
    setTimeout(() => {
      if (listening && mySession === sessionId) {
        try {
          createAndStart();
        } catch (err) {
          listening = false;
          stopWatchdog();
          emitError("restart-failed");
        }
      }
    }, 250); // brief pause so the browser can actually release the previous session/mic first
  }

  function startWatchdog() {
    stopWatchdog();
    watchdogId = setInterval(() => {
      if (listening && Date.now() - lastActivityAt > WATCHDOG_TIMEOUT_MS) {
        forceRestart();
      }
    }, WATCHDOG_CHECK_MS);
  }

  function stopWatchdog() {
    if (watchdogId) {
      clearInterval(watchdogId);
      watchdogId = null;
    }
  }

  function start() {
    if (!supported()) {
      emitError("unsupported");
      return;
    }
    if (listening) return; // already running

    listening = true;
    try {
      createAndStart();
      startWatchdog();
    } catch (err) {
      listening = false;
      emitError("start-failed");
    }
  }

  function stop() {
    emitDebugEvent("stop");
    emitListeningChange(false); // onend is nulled out below, so it won't emit this on its own
    listening = false;
    stopWatchdog();
    if (recognition) {
      recognition.onend = null; // don't auto-restart on an intentional stop
      try {
        recognition.stop();
      } catch {
        /* already stopped — fine */
      }
      recognition = null;
    }
  }

  return { supported, start, stop, onResult, onInterimResult, onError, onListeningChange, onDebugEvent };
})();
