/**
 * Design Chain — on-device speech recognition prototype (Vosk).
 *
 * Opt-in only: active when the URL has ?vosk (or ?vosk=grammar). It then
 * defines window.VoiceVosk, which voice.js uses in place of the browser's
 * SpeechRecognition — same interface (supported, start, stop, warmUp,
 * onResult, onInterimResult, onError, onListeningChange, onSleepChange,
 * onDebugEvent), plus prime(), so nothing else in the game changes.
 *
 * Why: on iPhone, Safari's speech recognizer stays deaf for ~20s after the
 * player leaves the app, while the raw getUserMedia microphone comes back
 * much sooner (v27/v30 diagnostics). Vosk runs a Kaldi model in a
 * WebAssembly worker on the raw microphone, so it should survive an app
 * switch. It also never plays Chrome's start sound on Android, since there
 * are no recognizer restarts.
 *
 * Pieces: vendor/vosk.js (vosk-browser 0.0.8, which bundles its worker) and
 * models/vosk-model-small-en-us-0.15.tar.gz (~41MB, the official small
 * English model repacked as tar.gz). The model starts loading as soon as
 * the page loads; the service worker caches it on first use.
 *
 * ?vosk=grammar restricts recognition to the game's own vocabulary (every
 * word of every non-AI term, plus "[unk]" for anything else), which should
 * be much more accurate for a word game. Words the model doesn't know are
 * skipped by Vosk (with a console warning).
 */
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has("vosk")) return;

  const MODEL_URL = "models/vosk-model-small-en-us-0.15.tar.gz";
  const LIBRARY_URL = "vendor/vosk.js";
  const USE_GRAMMAR = params.get("vosk") === "grammar";

  let resultCallbacks = [];
  let interimCallbacks = [];
  let errorCallbacks = [];
  let listeningCallbacks = [];
  let sleepCallbacks = [];
  let debugCallbacks = [];

  let modelPromise = null;
  let audioContext = null;
  let stream = null;
  let sourceNode = null;
  let processorNode = null;
  let muteNode = null;
  let recognizer = null;
  let listening = false; // we intend to be listening
  let isListeningNow = false; // audio is actually flowing into the recognizer
  let sessionId = 0;

  const subscribe = (list, callback) => {
    list.push(callback);
    return () => {
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  };
  const emit = (list, ...args) =>
    list.slice().forEach((callback) => {
      try {
        callback(...args);
      } catch (err) {
        console.error("VoiceVosk: callback threw", err);
      }
    });
  // Events from before anything subscribed (the model starts loading at
  // page load, before the debug panel subscribes) are held and replayed to
  // the first subscriber.
  let earlyDebugEvents = [];
  const emitDebugEvent = (type, detail) => {
    if (!debugCallbacks.length && earlyDebugEvents) earlyDebugEvents.push({ type, detail });
    else emit(debugCallbacks, { type, detail });
  };
  const emitListeningChange = (next) => {
    if (next === isListeningNow) return;
    isListeningNow = next;
    emit(listeningCallbacks, next);
  };

  function loadLibrary() {
    if (window.Vosk) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = LIBRARY_URL;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("vosk.js failed to load"));
      document.head.appendChild(script);
    });
  }

  function loadModel() {
    if (modelPromise) return modelPromise;
    const startedAt = performance.now();
    emitDebugEvent("vosk-model", "loading");
    modelPromise = loadLibrary()
      .then(() => window.Vosk.createModel(MODEL_URL))
      .then((model) => {
        emitDebugEvent("vosk-model", `ready in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
        return model;
      })
      .catch((err) => {
        emitDebugEvent("vosk-model", `failed: ${(err && err.message) || err}`);
        modelPromise = null; // allow a retry on the next start()
        throw err;
      });
    return modelPromise;
  }

  // The game's vocabulary for ?vosk=grammar.
  function buildGrammar() {
    const words = new Set();
    (typeof DESIGN_TERMS !== "undefined" ? DESIGN_TERMS : [])
      .filter((term) => term.category !== "AI")
      .forEach((term) => {
        [term.first, term.second, ...term.term.split(/\s+/)].forEach((word) => {
          const clean = String(word || "").toLowerCase().replace(/[^a-z']/g, "");
          if (clean) words.add(clean);
        });
      });
    return JSON.stringify([...words, "[unk]"]);
  }

  // Creates/resumes the AudioContext. iOS only lets an AudioContext start
  // (or resume after the app was in the background) inside a user gesture,
  // so ui.js calls this synchronously from the Play and "Keep playing" taps.
  function prime() {
    try {
      if (!audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtx();
      }
      if (audioContext.state !== "running") audioContext.resume().catch(() => {});
      emitDebugEvent("vosk-audio", `context ${audioContext.state}`);
    } catch (err) {
      emitDebugEvent("vosk-audio", `context failed: ${(err && err.message) || err}`);
    }
  }

  function teardownAudio() {
    if (processorNode) {
      processorNode.onaudioprocess = null;
      processorNode.disconnect();
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (muteNode) {
      muteNode.disconnect();
      muteNode = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (recognizer) {
      try {
        recognizer.remove();
      } catch {
        /* already gone */
      }
      recognizer = null;
    }
  }

  async function start() {
    if (listening) return;
    listening = true;
    const mySession = ++sessionId;
    emitDebugEvent("start", { session: mySession, engine: "vosk", grammar: USE_GRAMMAR });
    try {
      const model = await loadModel();
      if (!listening || mySession !== sessionId) return;

      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (!listening || mySession !== sessionId) {
        teardownAudio();
        return;
      }
      const track = stream.getAudioTracks()[0];
      track.onmute = () => emitDebugEvent("vosk-audio", "track muted");
      track.onunmute = () => emitDebugEvent("vosk-audio", "track unmuted");

      prime(); // no-op if already running; outside a gesture it may stay suspended on iOS
      recognizer = USE_GRAMMAR
        ? new model.KaldiRecognizer(audioContext.sampleRate, buildGrammar())
        : new model.KaldiRecognizer(audioContext.sampleRate);
      recognizer.on("partialresult", (message) => {
        const partial = message && message.result ? message.result.partial : "";
        if (partial && partial.trim()) {
          emitDebugEvent("interim", partial.trim());
          emit(interimCallbacks, partial.trim());
        }
      });
      recognizer.on("result", (message) => {
        const text = message && message.result ? message.result.text : "";
        if (text && text.trim()) {
          emitDebugEvent("result", text.trim());
          emit(resultCallbacks, text.trim(), [text.trim()]);
        }
      });

      sourceNode = audioContext.createMediaStreamSource(stream);
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      // A ScriptProcessor only runs while connected to the destination;
      // route it through a silent gain so the player never hears themselves.
      muteNode = audioContext.createGain();
      muteNode.gain.value = 0;
      let firstBuffer = true;
      processorNode.onaudioprocess = (event) => {
        if (!recognizer) return;
        if (firstBuffer) {
          firstBuffer = false;
          emitDebugEvent("audiostart", `context ${audioContext.state}, ${audioContext.sampleRate}Hz`);
          emitListeningChange(true);
        }
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch (err) {
          console.error("VoiceVosk: acceptWaveform failed", err);
        }
      };
      sourceNode.connect(processorNode);
      processorNode.connect(muteNode);
      muteNode.connect(audioContext.destination);
      emitDebugEvent("vosk-audio", `pipeline connected, context ${audioContext.state}`);
    } catch (err) {
      emitDebugEvent("error", (err && err.name) || String(err));
      listening = false;
      teardownAudio();
      emitListeningChange(false);
      emit(errorCallbacks, err && err.name === "NotAllowedError" ? "not-allowed" : "start-failed");
    }
  }

  function stop() {
    emitDebugEvent("stop");
    listening = false;
    sessionId++;
    teardownAudio();
    emitListeningChange(false);
  }

  window.VoiceVosk = {
    supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext)),
    start,
    stop,
    prime,
    warmUp: async () => {}, // not needed — Vosk reads the raw microphone directly
    onResult: (callback) => subscribe(resultCallbacks, callback),
    onInterimResult: (callback) => subscribe(interimCallbacks, callback),
    onError: (callback) => subscribe(errorCallbacks, callback),
    onListeningChange: (callback) => subscribe(listeningCallbacks, callback),
    onSleepChange: (callback) => subscribe(sleepCallbacks, callback), // Vosk never sleeps
    onDebugEvent: (callback) => {
      const unsubscribe = subscribe(debugCallbacks, callback);
      if (earlyDebugEvents) {
        earlyDebugEvents.forEach((event) => callback(event));
        earlyDebugEvents = null;
      }
      return unsubscribe;
    },
  };

  // Start downloading the model right away so it's ready by the time the
  // player presses Play (debug events before the panel subscribes go to
  // the console only).
  loadModel().catch((err) => console.error("VoiceVosk: model load failed", err));
})();
