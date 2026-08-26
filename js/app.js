const $ = (id) => document.getElementById(id);

const state = {
  stream: null,
  processedStream: null,
  mediaRecorder: null,
  audioChunks: [],
  recognition: null,
  recognitionLang: "es-UY",
  pendingLanguageSwitch: null,
  isRecording: false,
  isPaused: false,
  startedAt: null,
  elapsedBeforePause: 0,
  timerInterval: null,
  animationFrame: null,
  audioContext: null,
  analyser: null,
  wakeLock: null,
  deferredPrompt: null,
  sessionId: null,
  highlights: [],
  rawFragments: [],
  classifiedFragments: [],
  topicLocked: false,
  topicTokens: [],
  acceptedCount: 0,
  ignoredCount: 0,
  lastFinalAt: 0,
  backgroundEvents: [],
  keepAliveUrl: null
};

const STOP_WORDS = new Set([
  "a","al","algo","algunas","algunos","ante","antes","como","con","contra","cual","cuando","de","del","desde","donde",
  "dos","el","ella","ellas","ellos","en","entre","era","es","esa","esas","ese","eso","esos","esta","estaba","estado",
  "estas","este","esto","estos","fue","ha","hay","la","las","le","les","lo","los","más","me","mi","mis","muy","no",
  "nos","o","para","pero","por","porque","que","qué","se","ser","si","sin","sobre","su","sus","también","te","tener",
  "tiene","todo","tu","un","una","uno","unos","y","ya","yo","eh","este","bueno","tipo","osea","o sea","ta","este",
  "the","and","to","of","in","is","it","that","for","on","with","as","this","be","are","was","at","or","by","an",
  "from","not","have","has","you","we","they","he","she","i","a","so","well","like","yeah","okay","ok","um","uh"
]);

const SPANISH_HINTS = new Set(["que","para","porque","como","pero","tambien","entonces","cuando","donde","esto","esta","los","las","una","uno","del","con","por"]);
const ENGLISH_HINTS = new Set(["the","and","that","with","from","this","what","when","where","because","then","have","has","are","was","were","you","your","for"]);

function escapeHtml(value="") {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function escapeRegExp(value="") { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeWord(w="") {
  return w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function tokenWords(text, includeStop=false) {
  const words = (text.toLowerCase().match(/[a-záéíóúüñ0-9]{2,}/gi) || []).map(normalizeWord);
  return includeStop ? words : words.filter(w => !STOP_WORDS.has(w) && w.length >= 3);
}
function splitSentences(text) {
  return (text.match(/[^.!?]+[.!?]?/g) || []).map(s => s.trim()).filter(Boolean);
}
function shorten(s, n) { return s.length > n ? s.slice(0,n-1) + "…" : s; }

function textFromElement(id, placeholderText) {
  return $(id).innerText.replace(placeholderText, "").trim();
}
function getRawText() {
  return textFromElement("rawOutput", "La transcripción completa aparecerá acá...");
}
function getCleanText() {
  return textFromElement("cleanOutput", "Acá aparecerá solamente lo que la app considere parte del tema principal...");
}
function setTextElement(id, text, placeholder) {
  const el = $(id);
  el.innerHTML = "";
  if (!text) {
    el.innerHTML = `<p class="placeholder">${escapeHtml(placeholder)}</p>`;
    return;
  }
  splitSentences(text).forEach(line => {
    const p = document.createElement("p");
    p.textContent = line;
    el.appendChild(p);
  });
}
function appendParagraph(id, text) {
  const el = $(id);
  el.querySelector(".placeholder")?.remove();
  const p = document.createElement("p");
  p.textContent = text.trim();
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, mode="idle") {
  $("statusText").textContent = text;
  $("recordingBadge").className = `recording-badge ${mode}`;
  $("recordingBadgeText").textContent =
    mode === "live" ? "Grabando" : mode === "paused" ? "Pausado" : "Detenido";

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: mode === "live" ? "EscuchaMapa está grabando" : "EscuchaMapa",
        artist: text,
        album: "Sesión activa"
      });
      navigator.mediaSession.playbackState = mode === "live" ? "playing" : "paused";
    } catch (_) {}
  }
}

function updateButtons() {
  $("startBtn").disabled = state.isRecording && !state.isPaused;
  $("pauseBtn").disabled = !state.isRecording;
  $("stopBtn").disabled = !state.isRecording;
  $("pauseBtn").textContent = state.isPaused ? "Reanudar" : "Pausar";
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      state.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (_) {}
}

function createSilentWavUrl() {
  if (state.keepAliveUrl) return state.keepAliveUrl;
  const sampleRate = 8000;
  const seconds = 1;
  const samples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => [...s].forEach((c,i) => view.setUint8(offset+i, c.charCodeAt(0)));
  writeStr(0,"RIFF"); view.setUint32(4,36+samples*2,true); writeStr(8,"WAVE");
  writeStr(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  writeStr(36,"data"); view.setUint32(40,samples*2,true);
  for (let i=0;i<samples;i++) view.setInt16(44+i*2, 0, true);
  state.keepAliveUrl = URL.createObjectURL(new Blob([buffer], {type:"audio/wav"}));
  return state.keepAliveUrl;
}

async function startKeepAlive() {
  if (!$("resilientMode").checked) return;
  try {
    const audio = $("keepAliveAudio");
    audio.src = createSilentWavUrl();
    audio.volume = 0.001;
    await audio.play();
  } catch (_) {}
}
function stopKeepAlive() {
  try { $("keepAliveAudio").pause(); } catch (_) {}
}

async function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("EscuchaMapaDB", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chunks")) {
        const store = db.createObjectStore("chunks", { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique:false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function persistChunk(blob, index) {
  if (!$("resilientMode").checked || !state.sessionId) return;
  try {
    const db = await openAudioDB();
    const tx = db.transaction("chunks","readwrite");
    tx.objectStore("chunks").put({
      key: `${state.sessionId}:${String(index).padStart(8,"0")}`,
      sessionId: state.sessionId,
      index,
      type: blob.type,
      blob
    });
    await new Promise((resolve,reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("No se pudo persistir fragmento:", e);
  }
}
async function getPersistedChunks(sessionId) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction("chunks","readonly");
    const idx = tx.objectStore("chunks").index("sessionId");
    const req = idx.getAll(sessionId);
    const rows = await new Promise((resolve,reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.sort((a,b)=>a.index-b.index).map(r=>r.blob);
  } catch (_) { return []; }
}
async function clearPersistedChunks(sessionId) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction("chunks","readwrite");
    const idx = tx.objectStore("chunks").index("sessionId");
    const keysReq = idx.getAllKeys(sessionId);
    const keys = await new Promise((resolve,reject)=>{
      keysReq.onsuccess=()=>resolve(keysReq.result||[]);
      keysReq.onerror=()=>reject(keysReq.error);
    });
    keys.forEach(k => tx.objectStore("chunks").delete(k));
    db.close();
  } catch (_) {}
}

async function startListening() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    state.audioChunks = [];
    state.rawFragments = [];
    state.classifiedFragments = [];
    state.acceptedCount = 0;
    state.ignoredCount = 0;
    state.sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    state.backgroundEvents = [];

    await setupProcessedAudio();
    setupMediaRecorder();
    setupSpeechRecognition();
    setupAudioMeter();

    state.isRecording = true;
    state.isPaused = false;
    state.startedAt = Date.now();
    state.elapsedBeforePause = 0;
    startTimer();
    setStatus("Escuchando y clasificando", "live");
    updateButtons();

    await Promise.allSettled([requestWakeLock(), startKeepAlive()]);
  } catch (error) {
    console.error(error);
    setStatus("No se pudo acceder al micrófono");
    $("compatibilityNotice").classList.remove("hidden");
    $("compatibilityNotice").textContent =
      "No se pudo activar el micrófono. Revisá el permiso del navegador y abrí la app desde localhost o HTTPS.";
  }
}

async function setupProcessedAudio() {
  try {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioContext.state === "suspended") await state.audioContext.resume();
    const source = state.audioContext.createMediaStreamSource(state.stream);

    const highpass = state.audioContext.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;

    const compressor = state.audioContext.createDynamicsCompressor();
    compressor.threshold.value = -28;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;

    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;

    const destination = state.audioContext.createMediaStreamDestination();

    source.connect(highpass);
    highpass.connect(compressor);
    compressor.connect(state.analyser);
    compressor.connect(destination);

    state.processedStream = destination.stream;
  } catch (e) {
    console.warn("Procesamiento de audio no disponible:", e);
    state.processedStream = state.stream;
  }
}

function setupMediaRecorder() {
  try {
    const stream = state.processedStream || state.stream;
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4"
    ].find(type => MediaRecorder.isTypeSupported?.(type));

    state.mediaRecorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    let chunkIndex = 0;

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        state.audioChunks.push(e.data);
        persistChunk(e.data, chunkIndex++);
      }
    };
    state.mediaRecorder.onstop = () => saveCurrentSession();
    state.mediaRecorder.start(1000);
  } catch (error) {
    console.warn("MediaRecorder no disponible:", error);
  }
}

function selectedRecognitionLanguage() {
  const mode = $("languageSelect").value;
  if (mode === "bilingual") return state.recognitionLang || "es-UY";
  return mode;
}

function setupSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("compatibilityNotice").classList.remove("hidden");
    $("compatibilityNotice").textContent =
      "Este navegador puede grabar audio, pero no ofrece transcripción de voz en vivo. Probá Chrome o Edge en PC/Android. En iPhone la compatibilidad depende de Safari/WebKit.";
    return;
  }

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = selectedRecognitionLanguage();

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        state.lastFinalAt = Date.now();
        handleFinalTranscript(text);
      } else {
        interim += text;
      }
    }
    $("interimOutput").textContent = interim;
  };

  recognition.onerror = (event) => {
    console.warn("SpeechRecognition:", event.error);
  };

  recognition.onend = () => {
    if (state.pendingLanguageSwitch) {
      state.recognitionLang = state.pendingLanguageSwitch;
      state.pendingLanguageSwitch = null;
    }
    if (state.isRecording && !state.isPaused) {
      setTimeout(() => {
        try {
          recognition.lang = selectedRecognitionLanguage();
          recognition.start();
        } catch (_) {}
      }, 120);
    }
  };

  state.recognition = recognition;
  try { recognition.start(); } catch (_) {}
}

function detectLanguage(text) {
  const words = tokenWords(text, true);
  let es = 0, en = 0;
  for (const w of words) {
    if (SPANISH_HINTS.has(w)) es++;
    if (ENGLISH_HINTS.has(w)) en++;
  }
  if (/[ñáéíóú¿¡]/i.test(text)) es += 2;
  if (en >= es + 2) return "en-US";
  if (es >= en + 2) return "es-UY";
  return state.recognitionLang || "es-UY";
}

function maybeSwitchBilingualLanguage(text) {
  if ($("languageSelect").value !== "bilingual") return;
  const detected = detectLanguage(text);
  if (detected !== state.recognitionLang) {
    state.pendingLanguageSwitch = detected;
    try { state.recognition?.stop(); } catch (_) {}
  }
}

function removeFillers(text) {
  return text
    .replace(/\b(eh+|emm+|mmm+|um+|uh+)\b[,. ]*/gi, "")
    .replace(/\b(este|bueno|tipo|o sea)\b(?=[, ]{1,3})/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function handleFinalTranscript(text) {
  const cleaned = removeFillers(text);
  if (!cleaned) return;

  state.rawFragments.push({ text: cleaned, at: Date.now() });
  appendParagraph("rawOutput", cleaned);

  updateTopicModel(cleaned);
  const classification = classifyFragment(cleaned);
  state.classifiedFragments.push({ text: cleaned, ...classification, at: Date.now() });

  if (!$("autoClean").checked || classification.accepted) {
    appendParagraph("cleanOutput", cleaned);
    state.acceptedCount++;
  } else {
    state.ignoredCount++;
  }

  updateCleanStats();
  maybeSwitchBilingualLanguage(cleaned);
  autosaveDraft();

  if (state.acceptedCount % 3 === 0) {
    renderKeywords();
  }
}

function updateCleanStats() {
  $("acceptedCount").textContent = `${state.acceptedCount} fragment${state.acceptedCount === 1 ? "o útil" : "os útiles"}`;
  $("ignoredCount").textContent = `${state.ignoredCount} ignorado${state.ignoredCount === 1 ? "" : "s"}`;
}

function keywordData(text, limit=12) {
  const counts = {};
  tokenWords(text).forEach(w => counts[w] = (counts[w] || 0) + 1);
  return Object.entries(counts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word,count]) => ({word, count}));
}

function updateTopicModel(newText="") {
  const manual = $("topicInput").value.trim();
  if (manual) {
    state.topicTokens = keywordData(manual + " " + getCleanText(), 18).map(x=>x.word);
    $("topicStatus").textContent = `Tema: ${manual}${state.topicLocked ? " · fijado" : ""}`;
    $("mapTitle").value = manual;
    return;
  }
  if (state.topicLocked && state.topicTokens.length) return;

  const base = [...state.rawFragments].slice(0, Math.max(4, state.rawFragments.length)).map(x=>x.text).join(" ");
  const keys = keywordData(base, 16);
  state.topicTokens = keys.map(k=>k.word);

  if (keys.length) {
    const inferred = keys.slice(0,4).map(k=>k.word).join(" · ");
    $("topicStatus").textContent = `Tema detectado: ${inferred}`;
    $("mapTitle").value = keys.slice(0,2).map(k=>k.word).join(" / ") || "Tema principal";
  }
}

function strengthThreshold() {
  const v = $("filterStrength").value;
  return v === "soft" ? 0.11 : v === "strict" ? 0.28 : 0.18;
}

function classifyFragment(text) {
  const tokens = tokenWords(text);
  if (!tokens.length) return { accepted:false, score:0, reason:"sin contenido" };

  // Frases demasiado cortas tienden a ser ruido, salvo que contengan términos centrales.
  const unique = [...new Set(tokens)];
  const topic = new Set(state.topicTokens);

  let matches = unique.filter(w => topic.has(w)).length;
  let overlap = topic.size ? matches / Math.min(Math.max(unique.length,1), Math.max(topic.size,1)) : 1;

  // Continuidad: si comparte vocabulario con los últimos fragmentos aceptados, suma relevancia.
  const recentAccepted = state.classifiedFragments.filter(x=>x.accepted).slice(-3).map(x=>x.text).join(" ");
  const recentSet = new Set(tokenWords(recentAccepted));
  const continuityMatches = unique.filter(w => recentSet.has(w)).length;
  const continuity = recentSet.size ? continuityMatches / Math.max(unique.length,1) : 0;

  // Frecuencia global: términos repetidos en la conversación suelen pertenecer al tema.
  const globalKeys = new Set(keywordData(state.rawFragments.map(x=>x.text).join(" "), 24).map(k=>k.word));
  const globalMatch = unique.filter(w=>globalKeys.has(w)).length / Math.max(unique.length,1);

  const lengthBonus = Math.min(0.14, unique.length / 100);
  const score = overlap * 0.48 + continuity * 0.24 + globalMatch * 0.20 + lengthBonus;

  // Durante los primeros fragmentos se acepta más para poder aprender el tema.
  const bootstrap = state.rawFragments.length <= 4;
  const accepted = bootstrap || score >= strengthThreshold();

  return {
    accepted,
    score: Number(score.toFixed(3)),
    reason: accepted ? "central" : "secundario"
  };
}

function rebuildCleanTranscript() {
  updateTopicModel();
  const raw = [...state.rawFragments];
  state.classifiedFragments = [];
  state.acceptedCount = 0;
  state.ignoredCount = 0;
  setTextElement("cleanOutput","", "Acá aparecerá solamente lo que la app considere parte del tema principal...");

  raw.forEach((frag, index) => {
    const classification = classifyFragment(frag.text);
    state.classifiedFragments.push({ text: frag.text, ...classification, at: frag.at || Date.now() });
    if (!$("autoClean").checked || classification.accepted || index < 3) {
      appendParagraph("cleanOutput", frag.text);
      state.acceptedCount++;
    } else {
      state.ignoredCount++;
    }
  });

  updateCleanStats();
  analyzeAll();
  autosaveDraft();
}

function detectTopicNow() {
  $("topicInput").value = "";
  state.topicLocked = false;
  updateTopicModel();
  rebuildCleanTranscript();
}

function toggleTopicLock() {
  if (!state.topicTokens.length && !$("topicInput").value.trim()) updateTopicModel();
  state.topicLocked = !state.topicLocked;
  $("lockTopicBtn").textContent = state.topicLocked ? "Tema fijado" : "Fijar tema";
  $("lockTopicBtn").classList.toggle("primary", state.topicLocked);
  updateTopicModel();
}

function pauseOrResume() {
  if (!state.isRecording) return;

  if (!state.isPaused) {
    state.isPaused = true;
    state.elapsedBeforePause += Date.now() - state.startedAt;
    state.startedAt = null;
    try { state.mediaRecorder?.pause(); } catch (_) {}
    try { state.recognition?.stop(); } catch (_) {}
    stopKeepAlive();
    setStatus("Grabación pausada", "paused");
  } else {
    state.isPaused = false;
    state.startedAt = Date.now();
    try { state.mediaRecorder?.resume(); } catch (_) {}
    try {
      if (state.recognition) {
        state.recognition.lang = selectedRecognitionLanguage();
        state.recognition.start();
      }
    } catch (_) {}
    setStatus("Escuchando y clasificando", "live");
    Promise.allSettled([requestWakeLock(), startKeepAlive()]);
  }
  updateButtons();
}

function stopListening() {
  if (!state.isRecording) return;
  if (!state.isPaused && state.startedAt) state.elapsedBeforePause += Date.now() - state.startedAt;

  state.isRecording = false;
  state.isPaused = false;

  try { state.recognition?.stop(); } catch (_) {}
  try {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    else saveCurrentSession();
  } catch (_) { saveCurrentSession(); }

  state.stream?.getTracks().forEach(t => t.stop());
  state.processedStream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  state.processedStream = null;
  stopAudioMeter();
  stopTimer();
  stopKeepAlive();
  try { state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
  setStatus("Sesión finalizada");
  updateButtons();
  analyzeAll();
}

function startTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    let ms = state.elapsedBeforePause;
    if (state.isRecording && !state.isPaused && state.startedAt) ms += Date.now() - state.startedAt;
    $("timer").textContent = formatDuration(ms);
  }, 250);
}
function stopTimer() {
  clearInterval(state.timerInterval);
  $("timer").textContent = formatDuration(state.elapsedBeforePause);
}
function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function setupAudioMeter() {
  try {
    const analyser = state.analyser;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0)/data.length;
      $("audioLevel").style.width = `${Math.min(100, avg * 1.85)}%`;
      state.animationFrame = requestAnimationFrame(tick);
    };
    tick();
  } catch (_) {}
}
function stopAudioMeter() {
  cancelAnimationFrame(state.animationFrame);
  $("audioLevel").style.width = "0%";
  try { state.audioContext?.close(); } catch (_) {}
  state.audioContext = null;
  state.analyser = null;
}

function renderKeywords() {
  const data = keywordData(getCleanText(), 12);
  const box = $("keywords");
  box.innerHTML = "";
  if (!data.length) {
    box.innerHTML = '<span class="muted">Todavía no hay ideas principales.</span>';
    return data;
  }
  data.forEach(item => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = `${item.word} · ${item.count}`;
    btn.onclick = () => {
      $("searchInput").value = item.word;
      searchTranscript();
    };
    box.appendChild(btn);
  });
  return data;
}

function createSummary() {
  const text = getCleanText();
  const sentences = splitSentences(text).filter(s=>s.length>20);
  if (!sentences.length) {
    $("summaryOutput").textContent = "Necesito más texto central para generar un resumen.";
    return "";
  }
  const keywords = keywordData(text, 18);
  const weights = Object.fromEntries(keywords.map(k=>[k.word,k.count]));
  const scored = sentences.map((sentence,index)=>{
    const words = tokenWords(sentence);
    const score = words.reduce((sum,w)=>sum+(weights[w]||0),0)/Math.max(words.length,1);
    return {sentence,score,index};
  });
  const take = Math.min(5, Math.max(2, Math.ceil(sentences.length*.25)));
  const selected = scored.sort((a,b)=>b.score-a.score).slice(0,take).sort((a,b)=>a.index-b.index);
  const summary = selected.map(x=>x.sentence).join(" ");
  $("summaryOutput").textContent = summary;
  return summary;
}

function createQuestions() {
  const text = getCleanText();
  const keywords = keywordData(text,6);
  const output = $("questionsOutput");
  if (!keywords.length) {
    output.textContent = "Necesito más texto central para generar preguntas.";
    return [];
  }
  const english = detectLanguage(text) === "en-US";
  const esTemplates = [
    w=>`¿Qué significa ${w} dentro de este tema?`,
    w=>`¿Por qué ${w} es importante según lo escuchado?`,
    w=>`¿Cómo se relaciona ${w} con la idea principal?`,
    w=>`Explicá con tus palabras qué se dijo sobre ${w}.`,
    w=>`¿Qué ejemplo podrías dar relacionado con ${w}?`,
    w=>`¿Qué consecuencia o utilidad tiene ${w}?`
  ];
  const enTemplates = [
    w=>`What does ${w} mean in this topic?`,
    w=>`Why is ${w} important according to the discussion?`,
    w=>`How is ${w} related to the main idea?`,
    w=>`Explain in your own words what was said about ${w}.`,
    w=>`What example could you give about ${w}?`,
    w=>`What consequence or use does ${w} have?`
  ];
  const templates = english ? enTemplates : esTemplates;
  const questions = keywords.map((k,i)=>templates[i%templates.length](k.word));
  output.innerHTML = `<ol>${questions.map(q=>`<li>${escapeHtml(q)}</li>`).join("")}</ol>`;
  return questions;
}

function buildConceptMap() {
  const text = getCleanText();
  const container = $("conceptMap");
  const title = $("mapTitle").value.trim() || "Tema principal";
  const keywords = keywordData(text,9);
  if (!keywords.length) {
    container.innerHTML = '<div class="empty-state">Necesito texto central para construir el mapa.</div>';
    return;
  }

  const W=900,H=470,cx=W/2,cy=H/2,radius=170;
  let svg = `<svg class="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mapa conceptual">`;
  keywords.forEach((k,i)=>{
    const angle=(Math.PI*2*i/keywords.length)-Math.PI/2;
    const x=cx+Math.cos(angle)*radius*(i%2?1.08:.86);
    const y=cy+Math.sin(angle)*radius;
    svg += `<line class="map-line" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" />`;
  });
  svg += `<g class="map-node center"><circle cx="${cx}" cy="${cy}" r="68"></circle><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(shorten(title,18))}</text></g>`;
  keywords.forEach((k,i)=>{
    const angle=(Math.PI*2*i/keywords.length)-Math.PI/2;
    const x=cx+Math.cos(angle)*radius*(i%2?1.08:.86);
    const y=cy+Math.sin(angle)*radius;
    const r=42+Math.min(18,k.count*2);
    svg += `<g class="map-node" data-word="${escapeHtml(k.word)}"><circle cx="${x}" cy="${y}" r="${r}"></circle><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(shorten(k.word,13))}</text></g>`;
  });
  svg += `</svg>`;
  container.innerHTML = svg;
  container.querySelectorAll(".map-node[data-word]").forEach(node=>{
    node.style.cursor="pointer";
    node.onclick=()=>{
      $("searchInput").value=node.dataset.word;
      activateTab("clean");
      searchTranscript();
    };
  });
}

function searchTranscript() {
  const query=$("searchInput").value.trim();
  const text=getCleanText();
  const box=$("searchResults");
  box.innerHTML="";
  if (!query || !text) {
    box.textContent="Escribí una palabra para buscar.";
    return;
  }
  const sentences=splitSentences(text).filter(s=>s.toLowerCase().includes(query.toLowerCase()));
  if (!sentences.length) {
    box.textContent="No encontré coincidencias.";
    return;
  }
  sentences.slice(0,8).forEach(sentence=>{
    const div=document.createElement("div");
    div.className="search-hit";
    const safe=escapeHtml(sentence);
    const re=new RegExp(`(${escapeRegExp(query)})`,"ig");
    div.innerHTML=safe.replace(re,"<mark>$1</mark>");
    box.appendChild(div);
  });
}

function saveSelection() {
  const selection=window.getSelection()?.toString().trim();
  if (!selection) {
    alert("Seleccioná un fragmento del texto con el mouse o el dedo.");
    return;
  }
  state.highlights.unshift({text:selection,createdAt:new Date().toISOString()});
  renderHighlights();
  autosaveDraft();
}
function renderHighlights() {
  const box=$("highlightsOutput");
  box.innerHTML="";
  if (!state.highlights.length) {
    box.innerHTML='<span class="muted">Todavía no guardaste fragmentos.</span>';
    return;
  }
  state.highlights.forEach((h,index)=>{
    const div=document.createElement("div");
    div.className="highlight-item";
    div.innerHTML=`<strong>Fragmento ${state.highlights.length-index}</strong><p>${escapeHtml(h.text)}</p>`;
    box.appendChild(div);
  });
}

function getSessions() {
  try { return JSON.parse(localStorage.getItem("escuchamapa-sessions")||"[]"); }
  catch { return []; }
}
function setSessions(sessions) {
  localStorage.setItem("escuchamapa-sessions",JSON.stringify(sessions.slice(0,30)));
}

async function saveCurrentSession() {
  const raw=getRawText();
  const clean=getCleanText();
  const notes=$("notesArea").value.trim();
  if (!raw && !notes && !state.audioChunks.length) return;

  const session={
    id:state.sessionId||String(Date.now()),
    createdAt:new Date().toISOString(),
    durationMs:state.elapsedBeforePause,
    rawTranscript:raw,
    cleanTranscript:clean,
    notes,
    highlights:state.highlights,
    summary:createSummary(),
    keywords:keywordData(clean,12),
    topic:$("topicInput").value.trim(),
    languageMode:$("languageSelect").value,
    filterStrength:$("filterStrength").value,
    backgroundEvents:state.backgroundEvents
  };

  const sessions=getSessions().filter(s=>s.id!==session.id);
  sessions.unshift(session);
  setSessions(sessions);
  localStorage.removeItem("escuchamapa-draft");
  renderSessions();

  let chunks=state.audioChunks;
  if (!chunks.length) chunks=await getPersistedChunks(session.id);
  if (chunks.length) {
    const type=chunks[0]?.type || state.mediaRecorder?.mimeType || "audio/webm";
    const ext=type.includes("mp4") ? "m4a" : "webm";
    downloadBlob(new Blob(chunks,{type}),`EscuchaMapa-${new Date().toISOString().replace(/[:.]/g,"-")}.${ext}`);
  }
  await clearPersistedChunks(session.id);
}

function autosaveDraft() {
  const draft={
    rawTranscript:getRawText(),
    cleanTranscript:getCleanText(),
    notes:$("notesArea").value,
    highlights:state.highlights,
    rawFragments:state.rawFragments,
    classifiedFragments:state.classifiedFragments,
    topic:$("topicInput").value,
    topicTokens:state.topicTokens,
    topicLocked:state.topicLocked,
    acceptedCount:state.acceptedCount,
    ignoredCount:state.ignoredCount,
    updatedAt:new Date().toISOString()
  };
  localStorage.setItem("escuchamapa-draft",JSON.stringify(draft));
}
function restoreDraft() {
  try {
    const draft=JSON.parse(localStorage.getItem("escuchamapa-draft")||"null");
    if (!draft) return;
    if (draft.rawTranscript) setTextElement("rawOutput",draft.rawTranscript,"La transcripción completa aparecerá acá...");
    if (draft.cleanTranscript) setTextElement("cleanOutput",draft.cleanTranscript,"Acá aparecerá solamente lo que la app considere parte del tema principal...");
    if (draft.notes) $("notesArea").value=draft.notes;
    if (draft.topic) $("topicInput").value=draft.topic;
    state.highlights=draft.highlights||[];
    state.rawFragments=draft.rawFragments||splitSentences(draft.rawTranscript||"").map(text=>({text,at:Date.now()}));
    state.classifiedFragments=draft.classifiedFragments||[];
    state.topicTokens=draft.topicTokens||[];
    state.topicLocked=!!draft.topicLocked;
    state.acceptedCount=draft.acceptedCount||state.classifiedFragments.filter(x=>x.accepted).length;
    state.ignoredCount=draft.ignoredCount||state.classifiedFragments.filter(x=>!x.accepted).length;
    $("lockTopicBtn").textContent=state.topicLocked?"Tema fijado":"Fijar tema";
    $("lockTopicBtn").classList.toggle("primary",state.topicLocked);
    updateCleanStats();
    renderHighlights();
    updateTopicModel();
  } catch (_) {}
}

function renderSessions() {
  const sessions=getSessions();
  const box=$("sessionsList");
  box.innerHTML="";
  if (!sessions.length) {
    box.innerHTML='<span class="muted">Todavía no hay sesiones guardadas.</span>';
    return;
  }
  sessions.forEach(session=>{
    const item=document.createElement("div");
    item.className="session-item";
    const date=new Date(session.createdAt);
    const text=session.cleanTranscript||session.transcript||"";
    item.innerHTML=`
      <div>
        <strong>${date.toLocaleString()}</strong>
        <p>${formatDuration(session.durationMs||0)} · ${text.length} caracteres útiles</p>
      </div>
      <div class="inline-actions">
        <button class="btn small load-session">Abrir</button>
        <button class="btn small delete-session">Eliminar</button>
      </div>`;
    item.querySelector(".load-session").onclick=()=>loadSession(session.id);
    item.querySelector(".delete-session").onclick=()=>deleteSession(session.id);
    box.appendChild(item);
  });
}
function loadSession(id) {
  const session=getSessions().find(s=>s.id===id);
  if (!session) return;
  setTextElement("rawOutput",session.rawTranscript||session.transcript||"","La transcripción completa aparecerá acá...");
  setTextElement("cleanOutput",session.cleanTranscript||session.transcript||"","Acá aparecerá solamente lo que la app considere parte del tema principal...");
  $("notesArea").value=session.notes||"";
  $("topicInput").value=session.topic||"";
  if (session.languageMode) $("languageSelect").value=session.languageMode;
  if (session.filterStrength) $("filterStrength").value=session.filterStrength;
  state.highlights=session.highlights||[];
  state.rawFragments=splitSentences(session.rawTranscript||session.transcript||"").map(text=>({text,at:Date.now()}));
  renderHighlights();
  updateTopicModel();
  renderKeywords();
  createSummary();
  createQuestions();
  buildConceptMap();
  activateTab("clean");
}
function deleteSession(id) {
  if (!confirm("¿Eliminar esta sesión guardada?")) return;
  setSessions(getSessions().filter(s=>s.id!==id));
  renderSessions();
}

function exportTxt() {
  const raw=getRawText();
  const clean=getCleanText();
  const summary=createSummary();
  const notes=$("notesArea").value;
  const keywords=keywordData(clean,12).map(k=>k.word).join(", ");
  const body=`ESCUCHAMAPA

TEMA
${$("topicInput").value.trim()||$("topicStatus").textContent}

TEXTO LIMPIO
${clean}

RESUMEN
${summary}

PALABRAS CLAVE
${keywords}

NOTAS
${notes}

TRANSCRIPCIÓN COMPLETA
${raw}`;
  downloadBlob(new Blob([body],{type:"text/plain;charset=utf-8"}),"EscuchaMapa.txt");
}
function exportJson() {
  const data={
    exportedAt:new Date().toISOString(),
    topic:$("topicInput").value.trim(),
    cleanTranscript:getCleanText(),
    rawTranscript:getRawText(),
    summary:createSummary(),
    keywords:keywordData(getCleanText(),12),
    notes:$("notesArea").value,
    highlights:state.highlights,
    classifications:state.classifiedFragments
  };
  downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),"EscuchaMapa.json");
}
function downloadBlob(blob,filename) {
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function analyzeAll() {
  renderKeywords();
  createSummary();
  createQuestions();
  buildConceptMap();
}
function activateTab(id) {
  document.querySelectorAll(".tab").forEach(btn=>btn.classList.toggle("active",btn.dataset.tab===id));
  document.querySelectorAll(".tab-panel").forEach(panel=>panel.classList.toggle("active",panel.id===id));
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old=button.textContent;
    button.textContent="Copiado";
    setTimeout(()=>button.textContent=old,1200);
  } catch (_) {}
}

document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>activateTab(btn.dataset.tab)));
$("startBtn").addEventListener("click",startListening);
$("pauseBtn").addEventListener("click",pauseOrResume);
$("stopBtn").addEventListener("click",stopListening);
$("detectTopicBtn").addEventListener("click",detectTopicNow);
$("lockTopicBtn").addEventListener("click",toggleTopicLock);
$("rebuildCleanBtn").addEventListener("click",rebuildCleanTranscript);
$("filterStrength").addEventListener("change",rebuildCleanTranscript);
$("autoClean").addEventListener("change",rebuildCleanTranscript);
$("topicInput").addEventListener("change",()=>{ updateTopicModel(); rebuildCleanTranscript(); });
$("analyzeBtn").addEventListener("click",analyzeAll);
$("generateMapBtn").addEventListener("click",buildConceptMap);
$("summaryBtn").addEventListener("click",createSummary);
$("questionsBtn").addEventListener("click",createQuestions);
$("searchBtn").addEventListener("click",searchTranscript);
$("searchInput").addEventListener("keydown",e=>{if(e.key==="Enter")searchTranscript();});
$("saveSelectionBtn").addEventListener("click",saveSelection);
$("saveNotesBtn").addEventListener("click",()=>{autosaveDraft();alert("Notas guardadas en este dispositivo.");});
$("notesArea").addEventListener("input",autosaveDraft);
$("rawOutput").addEventListener("input",autosaveDraft);
$("cleanOutput").addEventListener("input",autosaveDraft);
$("copyCleanBtn").addEventListener("click",()=>copyText(getCleanText(),$("copyCleanBtn")));
$("copyRawBtn").addEventListener("click",()=>copyText(getRawText(),$("copyRawBtn")));
$("clearAllBtn").addEventListener("click",()=>{
  if (!confirm("¿Limpiar la transcripción completa y la versión filtrada?")) return;
  setTextElement("rawOutput","","La transcripción completa aparecerá acá...");
  setTextElement("cleanOutput","","Acá aparecerá solamente lo que la app considere parte del tema principal...");
  state.rawFragments=[]; state.classifiedFragments=[]; state.acceptedCount=0; state.ignoredCount=0; state.topicTokens=[];
  updateCleanStats(); autosaveDraft(); analyzeAll();
});
$("exportTxtBtn").addEventListener("click",exportTxt);
$("exportJsonBtn").addEventListener("click",exportJson);

window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  state.deferredPrompt=e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click",async()=>{
  if(!state.deferredPrompt)return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt=null;
  $("installBtn").classList.add("hidden");
});

document.addEventListener("visibilitychange",()=>{
  const hidden=document.visibilityState!=="visible";
  $("backgroundState").textContent=hidden?"Segundo plano":"Primer plano";
  $("backgroundState").classList.toggle("hidden-state",hidden);

  if (state.isRecording) {
    state.backgroundEvents.push({at:new Date().toISOString(),state:hidden?"hidden":"visible",recorderState:state.mediaRecorder?.state||"unknown"});
  }
  if (!hidden && state.isRecording && !state.isPaused) {
    requestWakeLock();
    startKeepAlive();
  }
});

window.addEventListener("pagehide",()=>{
  if (state.isRecording) autosaveDraft();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js").catch(console.warn));
}
if (!window.isSecureContext) {
  $("compatibilityNotice").classList.remove("hidden");
  $("compatibilityNotice").textContent=
    "El micrófono necesita un contexto seguro. Abrí este proyecto desde http://localhost con iniciar-servidor.bat o publicalo bajo HTTPS.";
}

restoreDraft();
renderSessions();
renderKeywords();
updateCleanStats();
