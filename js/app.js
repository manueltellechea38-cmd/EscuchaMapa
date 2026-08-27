const $ = id => document.getElementById(id);
const PLACEHOLDER = "Todavía no hay nada transcrito.";

const state = {
  stream: null,
  recorder: null,
  recognition: null,
  audioContext: null,
  analyser: null,
  frame: null,
  wakeLock: null,
  chunks: [],
  recording: false,
  paused: false,
  startedAt: 0,
  elapsed: 0,
  timer: null,
  fragments: [],
  sessionId: null,
  deferredPrompt: null,
  recognitionLang: "es-UY",
  votes: { es: 0, en: 0 },
  currentMap: null
};

const STOP = new Set("a al algo algunas algunos ante antes como con contra cual cuando de del desde donde el ella ellas ellos en entre era es esa esas ese eso esos esta estaba estado estas este esto estos fue ha hay la las le les lo los mas me mi mis muy no nos o para pero por porque que se ser si sin sobre su sus tambien te tener tiene todo tu un una uno unos y ya yo eh emm mmm bueno tipo osea the and to of in is it that for on with as this be are was at or by an from not have has you we they he she i so well like yeah okay ok um uh".split(" "));
const ES = new Set("que para porque como pero entonces cuando donde esta esto una con por del los las".split(" "));
const EN = new Set("the and that with from this what when where because then have has are you your for".split(" "));

function norm(s="") {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function words(text, keepStop=false) {
  const arr = (text.toLowerCase().match(/[a-záéíóúüñ0-9]{2,}/gi) || []).map(norm);
  return keepStop ? arr : arr.filter(w => w.length >= 3 && !STOP.has(w));
}

function punctuationSentences(text) {
  return (text.match(/[^.!?]+[.!?]?/g) || []).map(s => s.trim()).filter(Boolean);
}

function esc(value="") {
  return value.replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[c]));
}

function clean(text) {
  return text
    .replace(/\b(eh+|emm+|mmm+|um+|uh+)\b[,. ]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function keywordData(text, limit=12) {
  const counts = new Map();
  for (const w of words(text)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([word,count]) => ({word,count}));
}

function detectLanguage(text) {
  let es = /[ñáéíóú¿¡]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const w of words(text, true)) {
    if (ES.has(w)) es++;
    if (EN.has(w)) en++;
  }
  return en > es + 1 ? "en-US" : es > en + 1 ? "es-UY" : state.recognitionLang;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2,"0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2,"0");
  const s = String(total % 60).padStart(2,"0");
  return h + ":" + m + ":" + s;
}

function getText() {
  return $("cleanTranscript").innerText.replace(PLACEHOLDER, "").trim();
}

function transcriptUnits() {
  const domUnits = [...$("cleanTranscript").querySelectorAll("p")]
    .map(p => p.innerText.trim())
    .filter(t => t && t !== PLACEHOLDER);

  if (domUnits.length >= 2) return domUnits;

  const kept = state.fragments.filter(f => f.keep).map(f => f.text.trim()).filter(Boolean);
  if (kept.length >= 2) return kept;

  const plain = getText();
  if (!plain) return [];

  const punct = punctuationSentences(plain).filter(x => words(x).length >= 3);
  if (punct.length >= 2) return punct;

  const tokens = plain.split(/\s+/);
  const fallback = [];
  for (let i = 0; i < tokens.length; i += 24) {
    const chunk = tokens.slice(i, i + 24).join(" ").trim();
    if (chunk) fallback.push(chunk);
  }
  return fallback;
}

function renderTranscriptFragments(fragments) {
  const box = $("cleanTranscript");
  box.innerHTML = "";

  if (!fragments.length) {
    box.innerHTML = '<p class="placeholder">' + PLACEHOLDER + '</p>';
    return;
  }

  for (const fragment of fragments) {
    const p = document.createElement("p");
    p.textContent = typeof fragment === "string" ? fragment : fragment.text;
    box.appendChild(p);
  }
}

function header(text) {
  $("headerStatus").textContent = text;
}

function updateTimer() {
  let ms = state.elapsed;
  if (state.recording && !state.paused) ms += Date.now() - state.startedAt;
  $("timer").textContent = formatDuration(ms);
}

async function wake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      state.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {}
}

function audioSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "play-and-record";
  } catch {}
}

async function start() {
  try {
    audioSession();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    state.sessionId = crypto.randomUUID?.() || String(Date.now());
    state.chunks = [];
    meter();
    recordAudio();
    recognize();

    state.recording = true;
    state.paused = false;
    state.startedAt = Date.now();
    state.elapsed = 0;

    clearInterval(state.timer);
    state.timer = setInterval(updateTimer, 250);

    wake();
    updateUI();
    header("Grabando");
  } catch (error) {
    console.error(error);
    $("compatibilityNotice").classList.remove("hidden");
    $("compatibilityNotice").textContent =
      "No pude activar el micrófono. Revisá el permiso y que estés usando HTTPS o localhost.";
  }
}

function recordAudio() {
  const preferred = [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4"
  ].find(type => MediaRecorder.isTypeSupported?.(type));

  state.recorder = new MediaRecorder(state.stream, preferred ? {mimeType: preferred} : undefined);
  state.recorder.ondataavailable = e => {
    if (e.data?.size) state.chunks.push(e.data);
  };
  state.recorder.onstop = () => saveSession();
  state.recorder.start(1500);
}

function bestAlternative(result) {
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    if ((result[i].confidence || 0) > (best.confidence || 0)) best = result[i];
  }
  return best;
}

function recognize() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("qualityState").textContent = "Sin transcripción en vivo en este navegador";
    return;
  }

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  state.recognitionLang = $("languageSelect").value === "en-US" ? "en-US" : "es-UY";
  recognition.lang = state.recognitionLang;

  try {
    const topic = $("topicInput").value.trim();
    if (topic && "phrases" in recognition && window.SpeechRecognitionPhrase) {
      recognition.phrases = [
        new SpeechRecognitionPhrase(topic, 6),
        ...keywordData(topic, 6).map(k => new SpeechRecognitionPhrase(k.word, 4))
      ];
    }
  } catch {}

  recognition.onresult = event => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const alt = bestAlternative(event.results[i]);
      const spoken = clean(alt.transcript || "");
      if (!spoken) continue;

      if (event.results[i].isFinal) addFragment(spoken, alt.confidence || 0);
      else interim += spoken + " ";
    }
    $("interimTranscript").textContent = interim.trim();
  };

  recognition.onerror = event => {
    if (!["no-speech","aborted"].includes(event.error)) {
      $("qualityState").textContent = "Reconocimiento: " + event.error;
    }
  };

  recognition.onend = () => {
    if (!state.recording || state.paused) return;
    recognition.lang = state.recognitionLang;
    setTimeout(() => {
      try { recognition.start(); } catch {}
    }, 180);
  };

  state.recognition = recognition;
  try { recognition.start(); } catch {}
}

function addFragment(text, confidence) {
  const previous = state.fragments.at(-1)?.text || "";

  if (previous && norm(previous) === norm(text)) return;

  if (previous && previous.length > 20 && text.length > 20) {
    const a = previous.toLowerCase();
    const b = text.toLowerCase();
    if ((a.includes(b) || b.includes(a)) && Math.abs(a.length - b.length) < 25) {
      if (b.length <= a.length) return;
      state.fragments.pop();
    }
  }

  state.fragments.push({text, confidence, keep:true, at:Date.now()});

  if ($("languageSelect").value === "bilingual") {
    const detected = detectLanguage(text);
    detected === "en-US" ? state.votes.en++ : state.votes.es++;

    if (state.votes.en >= 2 && state.recognitionLang !== "en-US") {
      state.recognitionLang = "en-US";
      state.votes = {es:0,en:0};
      try { state.recognition.stop(); } catch {}
    } else if (state.votes.es >= 2 && state.recognitionLang !== "es-UY") {
      state.recognitionLang = "es-UY";
      state.votes = {es:0,en:0};
      try { state.recognition.stop(); } catch {}
    }
  }

  reclassify();
  $("undoBtn").disabled = !state.fragments.length;
  autosave();
}

function fragmentScore(fragment, topicWords, globalFrequency) {
  const unique = [...new Set(words(fragment.text))];
  if (!unique.length) return 0;

  let topicMatches = 0;
  let globalScore = 0;

  for (const w of unique) {
    if (topicWords.includes(w)) topicMatches++;
    globalScore += globalFrequency.get(w) || 0;
  }

  return (topicMatches / Math.max(2, Math.min(unique.length,8))) * .45
    + Math.min(1, globalScore / Math.max(4, unique.length * 2)) * .25
    + Math.min(1, unique.length / 9) * .18
    + Math.min(1, (fragment.confidence || .5) / .75) * .12;
}

function reclassify() {
  const manual = $("topicInput").value.trim();
  const all = state.fragments.map(f => f.text).join(" ");
  const topicWords = keywordData(manual + " " + manual + " " + all, 18).map(k => k.word);
  const global = new Map();

  for (const fragment of state.fragments) {
    for (const w of words(fragment.text)) global.set(w, (global.get(w) || 0) + 1);
  }

  state.fragments.forEach((fragment,index) => {
    const shortNoise = words(fragment.text).length <= 2 && (fragment.confidence || .5) < .45;
    fragment.keep = !shortNoise && (index < 4 || fragmentScore(fragment, topicWords, global) >= .27);
  });

  renderTranscriptFragments(state.fragments.filter(f => f.keep));
  renderRaw();
  updateInsights();
}

function pause() {
  if (!state.recording) return;

  if (!state.paused) {
    state.paused = true;
    state.elapsed += Date.now() - state.startedAt;
    try { state.recorder.pause(); } catch {}
    try { state.recognition?.stop(); } catch {}
  } else {
    state.paused = false;
    state.startedAt = Date.now();
    try { state.recorder.resume(); } catch {}
    try { state.recognition?.start(); } catch {}
    wake();
  }
  updateUI();
}

function finish() {
  if (!state.recording) return;
  if (!state.paused) state.elapsed += Date.now() - state.startedAt;

  state.recording = false;
  state.paused = false;

  try { state.recognition?.stop(); } catch {}
  try { if (state.recorder?.state !== "inactive") state.recorder.stop(); } catch {}

  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  stopMeter();

  clearInterval(state.timer);
  updateTimer();

  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;

  updateUI();
  header("Sesión finalizada");
  updateInsights(true);

}

function updateUI() {
  const button = $("recordButton");
  button.classList.toggle("live", state.recording && !state.paused);
  button.classList.toggle("paused", state.recording && state.paused);

  if (!state.recording) {
    $("recordTitle").textContent = "Tocá para empezar";
    $("recordSubtitle").textContent = state.fragments.length
      ? "La sesión quedó lista para revisar."
      : "Grabá una clase o conversación y quedate con lo importante.";
    $("micState").textContent = "Micrófono apagado";
  } else if (state.paused) {
    $("recordTitle").textContent = "Grabación pausada";
    $("recordSubtitle").textContent = "Tocá Reanudar para continuar.";
    $("micState").textContent = "Pausado";
  } else {
    $("recordTitle").textContent = "Escuchando";
    $("recordSubtitle").textContent = "Hablá con normalidad. La app va limpiando el texto.";
    $("micState").textContent = "Micrófono activo";
  }

  $("pauseBtn").disabled = !state.recording;
  $("finishBtn").disabled = !state.recording;
  $("pauseBtn").textContent = state.paused ? "Reanudar" : "Pausar";
}

function meter() {
  try {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    source.connect(state.analyser);

    const data = new Uint8Array(state.analyser.frequencyBinCount);
    const tick = () => {
      state.analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b) => a+b, 0) / data.length;
      $("audioLevel").style.width = Math.min(100, avg * 1.8) + "%";
      state.frame = requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}

function stopMeter() {
  cancelAnimationFrame(state.frame);
  $("audioLevel").style.width = "0%";
  try { state.audioContext?.close(); } catch {}
}

function renderRaw() {
  const box = $("rawTranscript");
  box.innerHTML = state.fragments.length
    ? state.fragments.map(fragment =>
        '<div class="raw-row"><span class="raw-tag ' + (fragment.keep ? "keep" : "skip") + '">'
        + (fragment.keep ? "USAR" : "OMITIR") + '</span><span>' + esc(fragment.text) + '</span></div>'
      ).join("")
    : '<span class="history-empty">Todavía no hay contenido.</span>';
}

function createSummary(units) {
  const useful = units.filter(unit => words(unit).length >= 4);
  if (!useful.length) return "";
  if (useful.length === 1) return useful[0];

  const fullText = useful.join(" ");
  const weights = new Map(keywordData(fullText, 20).map(k => [k.word, k.count]));

  const scored = useful.map((unit,index) => ({
    unit,
    index,
    score: words(unit).reduce((sum,w) => sum + (weights.get(w) || 0), 0) / Math.max(1, words(unit).length)
  }));

  const take = Math.min(4, Math.max(2, Math.ceil(useful.length * .28)));
  return scored
    .sort((a,b) => b.score - a.score)
    .slice(0, take)
    .sort((a,b) => a.index - b.index)
    .map(x => x.unit)
    .join(" ");
}

function relatedTerms(units, branchWord, limit=3) {
  const counts = new Map();

  for (const unit of units) {
    const unitWords = words(unit);
    if (!unitWords.includes(branchWord)) continue;

    for (const w of unitWords) {
      if (w === branchWord) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function buildMapData(units, topic) {
  const usable = units.filter(unit => words(unit).length >= 3);
  const allText = usable.join(" ");
  const keywords = keywordData(allText, 18);

  if (usable.length < 2 || keywords.length < 2) return null;

  const globalKeys = new Set(keywords.map(k => k.word));
  const branches = [];

  for (const key of keywords) {
    if (branches.length >= 5) break;

    const matches = usable.filter(unit => words(unit).includes(key.word));
    if (!matches.length) continue;

    const evidence = matches
      .map(unit => ({
        unit,
        score: words(unit).filter(w => globalKeys.has(w)).length + Math.min(18, words(unit).length) * .04
      }))
      .sort((a,b) => b.score - a.score)[0].unit;

    const tooSimilar = branches.some(branch => {
      const a = new Set(words(branch.evidence));
      const b = new Set(words(evidence));
      const overlap = [...a].filter(x => b.has(x)).length;
      return overlap / Math.max(1, Math.min(a.size,b.size)) > .75;
    });

    if (tooSimilar) continue;

    branches.push({
      word: key.word,
      evidence,
      links: relatedTerms(usable, key.word, 3)
    });
  }

  if (branches.length < 2) {
    const fallback = usable.slice(0, Math.min(4, usable.length)).map((unit,index) => ({
      word: keywordData(unit, 1)[0]?.word || ("Idea " + (index + 1)),
      evidence: unit,
      links: keywordData(unit, 4).slice(1).map(k => k.word)
    }));
    return {topic, branches:fallback};
  }

  return {topic, branches};
}


function shortenMapEvidence(text, maxWords=18) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return "";
  const parts = cleanText.split(/\s+/);
  if (parts.length <= maxWords) return cleanText;
  return parts.slice(0, maxWords).join(" ") + "…";
}

function mapRoundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mapWrapLines(ctx, text, maxWidth, maxLines=4) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? current + " " + token : token;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = token;
      if (lines.length >= maxLines - 1) break;
    } else {
      current = candidate;
    }
  }

  if (current && lines.length < maxLines) lines.push(current);

  const usedCount = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (usedCount < tokens.length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[.…]*$/, "") + "…";
  }

  return lines;
}

function mapDrawCenteredText(ctx, text, x, y, maxWidth, lineHeight, maxLines=4) {
  const lines = mapWrapLines(ctx, text, maxWidth, maxLines);
  const totalHeight = Math.max(0, (lines.length - 1) * lineHeight);
  const startY = y - totalHeight / 2;

  lines.forEach((line, index) => {
    ctx.fillText(line, x, startY + index * lineHeight);
  });
}

function mapDrawArrow(ctx, x1, y1, x2, y2, color="#7c8aa5", width=3, head=12) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - head * Math.cos(angle - Math.PI / 6),
    y2 - head * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    x2 - head * Math.cos(angle + Math.PI / 6),
    y2 - head * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function mapDrawConnector(ctx, startX, startY, endX, endY, elbowY) {
  ctx.save();
  ctx.strokeStyle = "#8491a7";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(startX, elbowY);
  ctx.lineTo(endX, elbowY);
  ctx.stroke();
  ctx.restore();

  mapDrawArrow(ctx, endX, elbowY, endX, endY, "#8491a7", 3, 13);
}

function drawConceptMapToCanvas(canvas, mapData, scale=2) {
  const branches = mapData.branches.slice(0, 5);
  const count = branches.length;

  const logicalWidth = Math.max(1200, 260 * count);
  const logicalHeight = 760;

  canvas.width = logicalWidth * scale;
  canvas.height = logicalHeight * scale;
  canvas.style.width = logicalWidth + "px";
  canvas.style.height = logicalHeight + "px";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // Background
  const bg = ctx.createLinearGradient(0, 0, logicalWidth, logicalHeight);
  bg.addColorStop(0, "#ffffff");
  bg.addColorStop(1, "#f7f8fc");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  // Small title
  ctx.fillStyle = "#8b95a7";
  ctx.font = "600 15px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MAPA CONCEPTUAL", logicalWidth / 2, 28);

  const centerX = logicalWidth / 2;

  // Main topic node
  const topicW = Math.min(430, Math.max(320, mapData.topic.length * 11 + 70));
  const topicH = 92;
  const topicX = centerX - topicW / 2;
  const topicY = 70;

  ctx.save();
  ctx.shadowColor = "rgba(91, 70, 180, .20)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  mapRoundRect(ctx, topicX, topicY, topicW, topicH, 26);
  const topicGradient = ctx.createLinearGradient(topicX, topicY, topicX + topicW, topicY + topicH);
  topicGradient.addColorStop(0, "#7c5cff");
  topicGradient.addColorStop(1, "#6748dc");
  ctx.fillStyle = topicGradient;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 25px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  mapDrawCenteredText(ctx, mapData.topic, centerX, topicY + topicH / 2 + 1, topicW - 54, 28, 3);

  // Concept positions
  const side = 115;
  const conceptY = 285;
  const conceptW = 190;
  const conceptH = 72;
  const explanationY = 490;
  const explanationW = 220;
  const explanationH = 150;
  const trunkY = 220;

  const xs = count === 1
    ? [centerX]
    : Array.from({length: count}, (_, i) =>
        side + i * ((logicalWidth - side * 2) / (count - 1))
      );

  // Main trunk from topic
  ctx.save();
  ctx.strokeStyle = "#8491a7";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(centerX, topicY + topicH);
  ctx.lineTo(centerX, trunkY);
  ctx.stroke();

  if (count > 1) {
    ctx.beginPath();
    ctx.moveTo(xs[0], trunkY);
    ctx.lineTo(xs[xs.length - 1], trunkY);
    ctx.stroke();
  }
  ctx.restore();

  branches.forEach((branch, index) => {
    const x = xs[index];

    // Arrows to concept
    mapDrawArrow(ctx, x, trunkY, x, conceptY - 16, "#8491a7", 3, 13);

    // Concept node shadow + gradient
    const conceptX = x - conceptW / 2;
    ctx.save();
    ctx.shadowColor = "rgba(82, 82, 160, .12)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 7;
    mapRoundRect(ctx, conceptX, conceptY, conceptW, conceptH, 20);
    const cg = ctx.createLinearGradient(conceptX, conceptY, conceptX + conceptW, conceptY + conceptH);
    cg.addColorStop(0, "#eef2ff");
    cg.addColorStop(1, "#e5e7ff");
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#8b87e8";
    ctx.lineWidth = 2;
    mapRoundRect(ctx, conceptX, conceptY, conceptW, conceptH, 20);
    ctx.stroke();

    ctx.fillStyle = "#37306f";
    ctx.font = "700 18px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    mapDrawCenteredText(ctx, branch.word, x, conceptY + conceptH / 2, conceptW - 28, 20, 2);

    // Arrow to explanation
    mapDrawArrow(
      ctx,
      x,
      conceptY + conceptH,
      x,
      explanationY - 16,
      "#9aa5b6",
      2.5,
      12
    );

    // Explanation card
    const exX = x - explanationW / 2;
    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, .08)";
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 7;
    mapRoundRect(ctx, exX, explanationY, explanationW, explanationH, 20);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#d9deea";
    ctx.lineWidth = 2;
    mapRoundRect(ctx, exX, explanationY, explanationW, explanationH, 20);
    ctx.stroke();

    ctx.fillStyle = "#7c5cff";
    ctx.beginPath();
    ctx.arc(exX + 24, explanationY + 24, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#334155";
    ctx.font = "15px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const evidence = shortenMapEvidence(branch.evidence, 20);
    mapDrawCenteredText(
      ctx,
      evidence,
      x,
      explanationY + 65,
      explanationW - 34,
      20,
      4
    );

    if (branch.links?.length) {
      ctx.fillStyle = "#8491a7";
      ctx.font = "600 11px Arial, sans-serif";
      mapDrawCenteredText(
        ctx,
        "Relacionado: " + branch.links.slice(0, 3).join(" · "),
        x,
        explanationY + explanationH - 22,
        explanationW - 30,
        15,
        2
      );
    }
  });

  // Footer line
  ctx.fillStyle = "#a0a8b5";
  ctx.font = "12px Arial, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("EscuchaMapa", logicalWidth - 34, logicalHeight - 24);

  state.currentMapCanvas = canvas;
}

function renderConceptMap(mapData) {
  const box = $("conceptMap");
  state.currentMap = mapData;

  if (!mapData || !mapData.branches?.length) {
    box.innerHTML =
      '<div class="empty-map"><strong>Necesito un poco más de contenido para generar el mapa.</strong>'
      + '<span>Probá grabando algunos fragmentos más o escribiendo el tema arriba.</span></div>';
    state.currentMapCanvas = null;
    return;
  }

  box.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "concept-map-canvas";
  canvas.setAttribute("aria-label", "Mapa conceptual");
  box.appendChild(canvas);

  drawConceptMapToCanvas(canvas, mapData, 2);
}

function updateInsights(showFeedback=false) {
  const units = transcriptUnits();
  const fullText = units.join(" ");
  const keywords = keywordData(fullText, 9);
  const manual = $("topicInput").value.trim();

  $("keywords").innerHTML = keywords.length
    ? keywords.map(item => '<span class="chip">' + esc(item.word) + '</span>').join("")
    : '<span class="history-empty">Sin conceptos todavía.</span>';

  const topic = manual || keywords.slice(0,3).map(item => item.word).join(" · ") || "Tema principal";
  $("detectedTopic").textContent = manual || keywords.slice(0,3).map(item => item.word).join(" · ") || "Todavía no hay suficiente texto";
  $("summary").textContent = createSummary(units) || "Todavía no hay suficiente texto.";

  renderConceptMap(buildMapData(units, topic));

  if (showFeedback) toast("Análisis actualizado");
}

function undo() {
  if (!state.fragments.length) return;
  state.fragments.pop();
  reclassify();
  $("undoBtn").disabled = !state.fragments.length;
  autosave();
}

function clearText() {
  if (!state.fragments.length && !getText()) return;
  if (!confirm("¿Borrar todo el texto de esta sesión?")) return;

  state.fragments = [];
  renderTranscriptFragments([]);
  $("interimTranscript").textContent = "";
  renderRaw();
  updateInsights();
  $("undoBtn").disabled = true;
  autosave();
}

function newSession() {
  if (state.recording) {
    alert("Finalizá la grabación antes de crear una sesión nueva.");
    return;
  }

  if ((state.fragments.length || getText()) && !confirm("¿Empezar una sesión nueva? La actual quedará guardada.")) return;
  if (state.fragments.length || getText()) saveSession();

  state.fragments = [];
  state.chunks = [];
  state.elapsed = 0;
  state.sessionId = null;
  state.currentMap = null;

  renderTranscriptFragments([]);
  $("rawTranscript").innerHTML = "";
  $("interimTranscript").textContent = "";
  $("topicInput").value = "";
  $("timer").textContent = "00:00:00";
  $("undoBtn").disabled = true;

  updateInsights();
  localStorage.removeItem("escuchamapa-v3-draft");
  header("Listo para escuchar");
}

function autosave() {
  localStorage.setItem("escuchamapa-v3-draft", JSON.stringify({
    fragments: state.fragments,
    topic: $("topicInput").value,
    language: $("languageSelect").value,
    elapsed: state.elapsed,
    updatedAt: new Date().toISOString()
  }));
}

function restore() {
  try {
    const data = JSON.parse(localStorage.getItem("escuchamapa-v3-draft") || "null");
    if (!data) return;

    state.fragments = Array.isArray(data.fragments) ? data.fragments : [];
    state.elapsed = data.elapsed || 0;
    $("topicInput").value = data.topic || "";
    if (data.language) $("languageSelect").value = data.language;

    reclassify();
    updateTimer();
    $("undoBtn").disabled = !state.fragments.length;
  } catch {}
}

function history() {
  try {
    return JSON.parse(localStorage.getItem("escuchamapa-v3-history") || "[]");
  } catch {
    return [];
  }
}

function saveSession() {
  const transcript = getText();
  if (!transcript && !state.fragments.length) return;

  const session = {
    id: state.sessionId || crypto.randomUUID?.() || String(Date.now()),
    createdAt: new Date().toISOString(),
    topic: $("topicInput").value.trim(),
    language: $("languageSelect").value,
    duration: state.elapsed,
    fragments: state.fragments,
    transcript
  };

  const items = history().filter(x => x.id !== session.id);
  items.unshift(session);
  localStorage.setItem("escuchamapa-v3-history", JSON.stringify(items.slice(0,25)));
  renderHistory();
}

function renderHistory() {
  const items = history();
  const box = $("historyList");

  if (!items.length) {
    box.innerHTML = '<span class="history-empty">No hay sesiones guardadas.</span>';
    return;
  }

  box.innerHTML = "";

  for (const session of items) {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML =
      '<div><strong>' + esc(session.topic || "Sesión") + '</strong>'
      + '<small>' + new Date(session.createdAt).toLocaleString() + " · " + formatDuration(session.duration || 0) + '</small></div>'
      + '<div class="history-actions"><button class="ghost open">Abrir</button>'
      + '<button class="ghost danger del">Eliminar</button></div>';

    el.querySelector(".open").onclick = () => openHistory(session.id);
    el.querySelector(".del").onclick = () => deleteHistory(session.id);
    box.appendChild(el);
  }
}

function openHistory(id) {
  if (state.recording) return;

  const session = history().find(x => x.id === id);
  if (!session) return;

  state.sessionId = session.id;
  state.fragments = session.fragments || punctuationSentences(session.transcript || "").map(text => ({
    text, confidence:.7, keep:true
  }));
  state.elapsed = session.duration || 0;

  $("topicInput").value = session.topic || "";
  if (session.language) $("languageSelect").value = session.language;

  reclassify();
  updateTimer();
  $("undoBtn").disabled = !state.fragments.length;
  window.scrollTo({top:0, behavior:"smooth"});
}

function deleteHistory(id) {
  localStorage.setItem(
    "escuchamapa-v3-history",
    JSON.stringify(history().filter(x => x.id !== id))
  );
  renderHistory();
}

function clearHistory() {
  if (!history().length) return;
  if (!confirm("¿Eliminar todo el historial?")) return;
  localStorage.removeItem("escuchamapa-v3-history");
  renderHistory();
}

function safeFilename(base, extension) {
  const cleanName = (base || "EscuchaMapa")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return (cleanName || "EscuchaMapa") + "." + extension;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTextTxt() {
  const transcript = getText();
  if (!transcript) {
    alert("No hay texto para descargar.");
    return;
  }

  const topic = $("topicInput").value.trim() || $("detectedTopic").textContent;
  const summaryText = $("summary").textContent;
  const content =
    "ESCUCHAMAPA\n\nTEMA\n" + topic
    + "\n\nRESUMEN\n" + summaryText
    + "\n\nTRANSCRIPCIÓN\n" + transcript;

  downloadBlob(
    new Blob([content], {type:"text/plain;charset=utf-8"}),
    safeFilename(topic || "EscuchaMapa", "txt")
  );
  toast("TXT descargado");
}

function exportTextPdf() {
  const transcript = getText();
  if (!transcript) {
    alert("No hay texto para descargar.");
    return;
  }

  if (!window.jspdf?.jsPDF) {
    alert("No se pudo cargar el generador de PDF. Revisá tu conexión e intentá nuevamente.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:"mm", format:"a4"});
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 18;
  const usableWidth = pageWidth - margin * 2;
  let y = 20;

  const topic = $("topicInput").value.trim() || $("detectedTopic").textContent || "EscuchaMapa";
  const summaryText = $("summary").textContent;

  const writeBlock = (text, size=11, gap=5, bold=false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, usableWidth);

    for (const line of lines) {
      if (y > pageHeight - 18) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, margin, y);
      y += size * 0.42 + 1.5;
    }
    y += gap;
  };

  writeBlock("EscuchaMapa", 18, 4, true);
  writeBlock(topic, 14, 8, true);
  writeBlock("Resumen", 12, 3, true);
  writeBlock(summaryText, 10.5, 7, false);
  writeBlock("Transcripción", 12, 3, true);

  for (const unit of transcriptUnits()) {
    writeBlock(unit, 10.5, 3, false);
  }

  doc.save(safeFilename(topic, "pdf"));
  toast("PDF descargado");
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines=5) {
  const tokens = text.split(/\s+/);
  let line = "";
  const lines = [];

  for (const token of tokens) {
    const test = line ? line + " " + token : token;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = token;
      if (lines.length >= maxLines - 1) break;
    } else {
      line = test;
    }
  }

  if (line && lines.length < maxLines) lines.push(line);

  if (tokens.length && lines.join(" ").split(/\s+/).length < tokens.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[.…]*$/, "") + "…";
  }

  lines.forEach((item,index) => ctx.fillText(item, x, y + index * lineHeight));
  return lines.length * lineHeight;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x+w, y, x+w, y+h, radius);
  ctx.arcTo(x+w, y+h, x, y+h, radius);
  ctx.arcTo(x, y+h, x, y, radius);
  ctx.arcTo(x, y, x+w, y, radius);
  ctx.closePath();
}


function exportMapPng() {
  updateInsights();

  const data = state.currentMap;
  const sourceCanvas = state.currentMapCanvas || $("conceptMap").querySelector("canvas.concept-map-canvas");

  if (!data || !data.branches?.length || !sourceCanvas) {
    alert("Todavía no hay suficiente contenido para descargar un mapa.");
    return;
  }

  // Re-render in high resolution for a sharp exported PNG.
  const exportCanvas = document.createElement("canvas");
  drawConceptMapToCanvas(exportCanvas, data, 3);

  exportCanvas.toBlob(blob => {
    if (!blob) {
      alert("No pude generar la imagen del mapa.");
      return;
    }

    downloadBlob(blob, safeFilename(data.topic || "mapa-conceptual", "png"));
    toast("Mapa PNG descargado");
  }, "image/png", 1);
}

function toast(message) {
  document.querySelector(".export-toast")?.remove();
  const el = document.createElement("div");
  el.className = "export-toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

$("recordButton").onclick = () => {
  if (!state.recording) start();
};
$("pauseBtn").onclick = pause;
$("finishBtn").onclick = finish;
$("undoBtn").onclick = undo;
$("newSessionBtn").onclick = newSession;
$("clearTextBtn").onclick = clearText;

$("copyBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(getText());
    $("copyBtn").textContent = "Copiado";
    setTimeout(() => $("copyBtn").textContent = "Copiar", 1000);
  } catch {}
};

$("exportTextPdfBtn").onclick = exportTextPdf;
$("exportTextTxtBtn").onclick = exportTextTxt;
$("exportMapPngBtn").onclick = exportMapPng;

$("toggleRawBtn").onclick = () => {
  $("rawDrawer").classList.toggle("hidden");
  $("toggleRawBtn").textContent = $("rawDrawer").classList.contains("hidden")
    ? "Ver todo lo escuchado"
    : "Ocultar texto completo";
};

$("refreshInsightsBtn").onclick = () => updateInsights(true);
$("rebuildMapBtn").onclick = () => {
  updateInsights();
  toast(state.currentMap ? "Mapa regenerado" : "Falta contenido para el mapa");
};

$("clearHistoryBtn").onclick = clearHistory;

$("topicInput").oninput = () => {
  if (state.fragments.length) reclassify();
  else updateInsights();
  autosave();
};

$("languageSelect").onchange = autosave;

$("cleanTranscript").oninput = () => {
  updateInsights();
};

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  state.deferredPrompt = event;
  $("installBtn").classList.remove("hidden");
});

$("installBtn").onclick = async () => {
  if (!state.deferredPrompt) return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  $("installBtn").classList.add("hidden");
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.recording && !state.paused) wake();
});

window.addEventListener("pagehide", () => {
  if (state.fragments.length) autosave();
});

if ("serviceWorker" in navigator) {
  let registrationRef = null;
  let reloadingForUpdate = false;

  function showUpdateButton(registration) {
    registrationRef = registration;
    const button = $("updateAppBtn");
    if (!button) return;

    if (registration?.waiting) {
      button.classList.remove("hidden");
      button.textContent = "Actualizar app";
    } else {
      button.classList.add("hidden");
    }
  }

  async function checkForAppUpdate() {
    if (!registrationRef) return;
    try {
      await registrationRef.update();
      showUpdateButton(registrationRef);
    } catch (error) {
      console.warn("No se pudo comprobar la actualización:", error);
    }
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", {
        updateViaCache: "none"
      });

      registrationRef = registration;
      showUpdateButton(registration);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateButton(registration);
            if (registration.waiting) toast("Hay una actualización disponible");
          }
        });
      });

      await checkForAppUpdate();

      setInterval(checkForAppUpdate, 5 * 60 * 1000);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          checkForAppUpdate();
        }
      });
    } catch (error) {
      console.warn("No se pudo registrar el Service Worker:", error);
    }
  });

  $("updateAppBtn")?.addEventListener("click", () => {
    if (state.recording) {
      alert("Finalizá la grabación antes de actualizar la app para no cortar la sesión.");
      return;
    }

    if (!registrationRef?.waiting) {
      checkForAppUpdate();
      return;
    }

    $("updateAppBtn").textContent = "Actualizando…";
    $("updateAppBtn").disabled = true;
    registrationRef.waiting.postMessage({ type: "SKIP_WAITING" });
  });
}

if (!window.isSecureContext) {
  $("compatibilityNotice").classList.remove("hidden");
  $("compatibilityNotice").textContent =
    "Abrí EscuchaMapa desde HTTPS o localhost para usar el micrófono.";
}

restore();
renderRaw();
renderHistory();
updateInsights();
updateUI();