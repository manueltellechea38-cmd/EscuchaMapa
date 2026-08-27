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
  currentMap: null,
  currentMapCanvas: null,
  translatedMap: null,
  translatedStudy: null,
  translatedSummary: "",
  translationSource: "",
  showingTranslation: false,
  materialSources: [],
  analysisMode: "listen",
  studyPurpose: "understand",
  currentStudy: {points:[], questions:[]},
  currentSummary: "",
  currentProfile: null
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

function capitalizeFirst(text="") {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function prettyConcept(text="") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (/^[A-ZÁÉÍÓÚÑ0-9]{2,}$/.test(value)) return value;
  return capitalizeFirst(value);
}

function polishSentence(text="") {
  let value = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (!value) return "";
  value = capitalizeFirst(value);
  if (!/[.!?…]$/.test(value)) value += ".";
  return value;
}

function originalWordForKey(text, key) {
  const originals = String(text || "").match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{2,}/g) || [];
  const match = originals.find(token => norm(token) === key);
  return match || key;
}

function keywordData(text, limit=12) {
  const counts = new Map();
  const labels = new Map();
  const originals = String(text || "").match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{2,}/g) || [];

  for (const token of originals) {
    const key = norm(token);
    if (key.length < 3 || STOP.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!labels.has(key)) labels.set(key, token);
  }

  return [...counts.entries()]
    .sort((a,b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([word,count]) => ({
      word,
      label: prettyConcept(labels.get(word) || word),
      count
    }));
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



function detectContentLanguage(text) {
  const tokens = words(text, true);
  if (!tokens.length) return "unknown";

  let es = /[ñáéíóú¿¡]/i.test(text) ? 4 : 0;
  let en = 0;

  for (const token of tokens) {
    if (ES.has(token)) es++;
    if (EN.has(token)) en++;
  }

  if (state.analysisMode === "listen") {
    const selected = $("languageSelect")?.value;
    if (selected === "en-US") en += 3;
    if (selected === "es-UY") es += 2;
  }

  if (en >= es + 2) return "en-US";
  if (es >= en + 2) return "es-UY";
  return "mixed";
}

function languageLabel(code) {
  if (code === "en-US") return "English";
  if (code === "es-UY") return "Español";
  if (code === "mixed") return "Mixto";
  return "Sin detectar";
}

function buildStudyData(mapData, languageCode, units=analysisUnits(), profile=studyProfile()) {
  if (!mapData?.branches?.length) return {points:[], questions:[]};

  const isEnglish = languageCode === "en-US";
  const points = [];
  const questions = [];

  for (const branch of mapData.branches) {
    let point = branch.word + ": " + polishSentence(branch.evidence);
    if (branch.links?.length) {
      point += isEnglish
        ? " Related to " + branch.links.join(", ") + "."
        : " Se relaciona con " + branch.links.join(", ") + ".";
    }
    points.push(point);

    questions.push({
      question: isEnglish
        ? "How would you explain " + branch.word + " in your own words?"
        : "¿Cómo explicarías " + branch.word + " con tus propias palabras?",
      answer: polishSentence(branch.evidence)
    });
  }

  const rankedExtra = units
    .map(polishSentence)
    .filter(unit => words(unit).length >= 5)
    .filter(unit => !points.some(point => mapSimilarity(point, unit) > .62));

  for (const unit of rankedExtra) {
    if (points.length >= profile.points) break;
    points.push(unit);
  }

  let extraIndex = 0;
  while (questions.length < profile.questions && extraIndex < rankedExtra.length) {
    const unit = rankedExtra[extraIndex++];
    const key = keywordData(unit, 1)[0]?.label || (isEnglish ? "this idea" : "esta idea");

    questions.push({
      question:
        profile.purpose === "exam"
          ? (isEnglish
              ? "What should you remember about " + key + " for an exam?"
              : "¿Qué deberías recordar sobre " + key + " para una prueba?")
          : (isEnglish
              ? "What is the main idea related to " + key + "?"
              : "¿Cuál es la idea principal relacionada con " + key + "?"),
      answer: unit
    });
  }

  if (questions.length < profile.questions && mapData.branches.length >= 2) {
    const a = mapData.branches[0];
    const b = mapData.branches[1];
    questions.push({
      question:isEnglish
        ? "What relationship can you identify between " + a.word + " and " + b.word + "?"
        : "¿Qué relación podés encontrar entre " + a.word + " y " + b.word + "?",
      answer:isEnglish
        ? polishSentence(a.evidence + " " + b.evidence)
        : polishSentence(a.evidence + " " + b.evidence)
    });
  }

  return {
    points:points.slice(0, profile.points),
    questions:questions.slice(0, profile.questions)
  };
}

function renderStudy(studyData) {
  const points = studyData?.points || [];
  const questions = studyData?.questions || [];
  state.currentStudy = studyData || {points:[], questions:[]};

  $("studyPoints").innerHTML = points.length
    ? "<ol>" + points.map(item => "<li>" + esc(item) + "</li>").join("") + "</ol>"
    : '<span class="history-empty">Todavía no hay suficiente contenido.</span>';

  $("studyQuestions").innerHTML = questions.length
    ? questions.map((item,index) =>
        '<details class="qa-card">'
        + '<summary><span>' + (index + 1) + '.</span>' + esc(item.question || item) + '</summary>'
        + '<div class="qa-answer"><strong>Respuesta</strong><p>'
        + esc(item.answer || "") + '</p></div></details>'
      ).join("")
    : '<span class="history-empty">Todavía no hay preguntas.</span>';
}

function updateLanguageTools(fullText) {
  const detected = detectContentLanguage(fullText);
  $("detectedLanguage").textContent = languageLabel(detected);

  if (detected === "en-US") $("translationTarget").value = "es";
  if (detected === "es-UY") $("translationTarget").value = "en";

  const signature = norm(fullText).slice(0, 1600);
  if (state.translationSource && state.translationSource !== signature) {
    state.translatedMap = null;
    state.translatedStudy = null;
    state.translatedSummary = "";
    state.translationSource = "";
    state.showingTranslation = false;
    $("showOriginalMapBtn").classList.add("hidden");
    $("translationStatus").textContent = "La traducción se muestra dentro de EscuchaMapa.";
  }

  return detected;
}

function splitTranslationText(text, maxBytes=420) {
  const source = String(text || "").trim();
  if (!source) return [];

  const encoder = new TextEncoder();
  const chunks = [];
  let current = "";

  const pieces = punctuationSentences(source).length
    ? punctuationSentences(source)
    : source.split(/\s+/);

  for (const piece of pieces) {
    const candidate = current ? current + " " + piece : piece;

    if (encoder.encode(candidate).length <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (encoder.encode(piece).length <= maxBytes) {
      current = piece;
      continue;
    }

    // Very long fragment: split by words without breaking UTF-8 limits.
    let wordChunk = "";
    for (const word of piece.split(/\s+/)) {
      const wordCandidate = wordChunk ? wordChunk + " " + word : word;
      if (encoder.encode(wordCandidate).length > maxBytes && wordChunk) {
        chunks.push(wordChunk);
        wordChunk = word;
      } else {
        wordChunk = wordCandidate;
      }
    }
    if (wordChunk) chunks.push(wordChunk);
  }

  if (current) chunks.push(current);
  return chunks;
}

async function createTranslationEngine(sourceCode, targetCode) {
  // Use the browser's native Translator API when available.
  if (sourceCode !== "auto" && globalThis.Translator?.create) {
    try {
      const translator = await globalThis.Translator.create({
        sourceLanguage: sourceCode,
        targetLanguage: targetCode
      });

      return {
        type: "browser",
        translate: async text => {
          const chunks = splitTranslationText(text, 900);
          const translated = [];
          for (const chunk of chunks) translated.push(await translator.translate(chunk));
          return translated.join(" ");
        },
        destroy: () => translator.destroy?.()
      };
    } catch (error) {
      console.warn("Traductor integrado no disponible:", error);
    }
  }

  // Reliable no-key fallback. MyMemory expects a concrete language pair.
  const fallbackSource = sourceCode === "auto"
    ? (targetCode === "es" ? "en" : "es")
    : sourceCode;

  return {
    type: "online",
    translate: async text => {
      const chunks = splitTranslationText(text, 420);
      const translatedChunks = [];

      for (const chunk of chunks) {
        const url =
          "https://api.mymemory.translated.net/get?q="
          + encodeURIComponent(chunk)
          + "&langpair="
          + encodeURIComponent(fallbackSource + "|" + targetCode)
          + "&mt=1";

        const response = await fetch(url, {
          method: "GET",
          mode: "cors",
          cache: "no-store"
        });

        if (!response.ok) throw new Error("HTTP " + response.status);

        const data = await response.json();
        const translated = data?.responseData?.translatedText;

        if (!translated) {
          const message = data?.responseDetails || "Respuesta sin traducción";
          throw new Error(message);
        }

        translatedChunks.push(translated);
      }

      return translatedChunks.join(" ");
    },
    destroy: () => {}
  };
}

function decodeTranslatedText(text="") {
  const area = document.createElement("textarea");
  area.innerHTML = String(text || "");
  return area.value.replace(/\s+/g, " ").trim();
}

async function translateConcept(engine, text, sourceCode, targetCode) {
  const sourcePrefix = sourceCode === "es" ? "Concepto de estudio: " : "Study concept: ";
  const translated = decodeTranslatedText(await engine.translate(sourcePrefix + text));
  const afterColon = translated.includes(":")
    ? translated.slice(translated.indexOf(":") + 1).trim()
    : translated;
  return prettyConcept(afterColon || translated);
}

async function translateGeneratedContent() {
  const units = analysisUnits();
  const fullText = units.join(" ");
  if (!fullText) {
    alert("Todavía no hay contenido para traducir.");
    return;
  }

  const detected = detectContentLanguage(fullText);
  const sourceCode = detected === "en-US" ? "en" : detected === "es-UY" ? "es" : "auto";
  const targetCode = $("translationTarget").value;

  if (sourceCode !== "auto" && sourceCode === targetCode) {
    toast("Elegí un idioma distinto al original");
    return;
  }

  const profile = state.currentProfile || studyProfile();
  const originalMap = state.currentMap
    || buildMapData(units, $("detectedTopic").textContent || "Tema principal", profile.branches);
  const originalSummary = state.currentSummary || createSummary(units, profile);
  const originalStudy = state.currentStudy?.questions?.length
    ? state.currentStudy
    : buildStudyData(originalMap, detected, units, profile);

  if (!originalMap?.branches?.length) {
    alert("Necesito un poco más de contenido antes de traducir los resultados.");
    return;
  }

  const button = $("translateGeneratedBtn");
  const oldLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Traduciendo…";
  $("translationStatus").textContent = "Traduciendo resumen, mapa, conceptos y respuestas…";

  let engine = null;

  try {
    engine = await createTranslationEngine(sourceCode, targetCode);

    const translatedMap = {
      topic: prettyConcept(decodeTranslatedText(await engine.translate(originalMap.topic))),
      branches: []
    };

    for (const branch of originalMap.branches) {
      translatedMap.branches.push({
        word: await translateConcept(engine, branch.word, sourceCode, targetCode),
        evidence: polishSentence(decodeTranslatedText(await engine.translate(branch.evidence))),
        secondaryEvidence: branch.secondaryEvidence
          ? polishSentence(decodeTranslatedText(await engine.translate(branch.secondaryEvidence)))
          : "",
        links: branch.links?.length
          ? await Promise.all(branch.links.map(link =>
              translateConcept(engine, link, sourceCode, targetCode)
            ))
          : []
      });
    }

    const translatedStudy = {
      points: await Promise.all(originalStudy.points.map(async item =>
        polishSentence(decodeTranslatedText(await engine.translate(item)))
      )),
      questions: await Promise.all(originalStudy.questions.map(async item => ({
        question: polishSentence(decodeTranslatedText(await engine.translate(item.question || item))),
        answer: item.answer
          ? polishSentence(decodeTranslatedText(await engine.translate(item.answer)))
          : ""
      })))
    };

    const translatedSummary = decodeTranslatedText(await engine.translate(originalSummary))
      .split(/\n{2,}/)
      .map(polishSentence)
      .join("\n\n");

    state.translatedMap = translatedMap;
    state.translatedStudy = translatedStudy;
    state.translatedSummary = translatedSummary;
    state.translationSource = norm(fullText).slice(0,1600);
    state.showingTranslation = true;

    $("detectedTopic").textContent = translatedMap.topic;
    $("summary").textContent = translatedSummary;
    $("keywords").innerHTML = translatedMap.branches
      .map(branch => '<span class="chip">' + esc(prettyConcept(branch.word)) + "</span>")
      .join("");

    renderConceptMap(translatedMap);
    renderStudy(translatedStudy);

    $("showOriginalMapBtn").classList.remove("hidden");
    $("translationStatus").textContent =
      engine.type === "browser"
        ? "Traducido dentro del dispositivo."
        : "Traducción lista dentro de EscuchaMapa.";
    toast("Resultados traducidos");
  } catch (error) {
    console.warn("Traducción:", error);
    $("translationStatus").textContent =
      "No pude completar la traducción. Revisá tu conexión e intentá nuevamente.";
    alert("No pude completar la traducción en este momento.");
  } finally {
    engine?.destroy?.();
    button.disabled = false;
    button.textContent = oldLabel;
  }
}

function showOriginalAnalysis() {
  state.showingTranslation = false;
  $("showOriginalMapBtn").classList.add("hidden");
  updateInsights();
  $("translationStatus").textContent = "Mostrando los resultados originales.";
}

function copyStudyMaterial() {
  const content = [
    "ESCUCHAMAPA - MODO ESTUDIO",
    "",
    "TEMA",
    $("detectedTopic").textContent,
    "",
    "RESUMEN",
    $("summary").textContent,
    "",
    "PUNTOS CLAVE",
    $("studyPoints").innerText.trim(),
    "",
    "PREGUNTAS PARA REPASAR",
    $("studyQuestions").innerText.trim()
  ].join("\n");

  navigator.clipboard.writeText(content)
    .then(() => toast("Material de estudio copiado"))
    .catch(() => {});
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


function textToUnits(text) {
  const cleanText = String(text || "").replace(/\r/g, "\n").trim();
  if (!cleanText) return [];

  const paragraphs = cleanText
    .split(/\n{2,}|\n(?=[A-ZÁÉÍÓÚÑ0-9])/)
    .map(part => part.trim())
    .filter(Boolean);

  const units = [];
  for (const paragraph of paragraphs) {
    if (words(paragraph).length <= 38) {
      units.push(paragraph);
      continue;
    }

    const sentences = punctuationSentences(paragraph).filter(sentence => words(sentence).length >= 3);
    if (sentences.length >= 2) {
      units.push(...sentences);
      continue;
    }

    const tokens = paragraph.split(/\s+/);
    for (let i = 0; i < tokens.length; i += 28) {
      const chunk = tokens.slice(i, i + 28).join(" ").trim();
      if (chunk) units.push(chunk);
    }
  }

  return units;
}

function analysisUnits() {
  if (state.analysisMode === "material") {
    return state.materialSources
      .filter(source => source.enabled !== false)
      .flatMap(source => textToUnits(source.text));
  }

  return transcriptUnits();
}

function analysisText() {
  return analysisUnits().join(" ");
}

function analysisSourceName() {
  if (state.analysisMode === "material") {
    const enabled = state.materialSources.filter(source => source.enabled !== false);
    if (!enabled.length) return "Material importado";
    return enabled.length === 1 ? enabled[0].name : enabled.length + " fuentes combinadas";
  }
  return "Grabación / transcripción";
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
    state.analysisMode = "listen";
    state.showingTranslation = false;
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

function analysisSizeInfo() {
  if (state.analysisMode !== "material") {
    const totalWords = analysisUnits().reduce((sum, unit) => sum + words(unit, true).length, 0);
    return {pages:Math.max(1, Math.ceil(totalWords / 430)), realPdfPages:0, estimated:true};
  }

  const active = state.materialSources.filter(source => source.enabled !== false);
  let realPdfPages = 0;
  let otherWords = 0;

  for (const source of active) {
    if (source.type === "pdf" && source.pageCount) realPdfPages += source.pageCount;
    else otherWords += words(source.text || "", true).length;
  }

  const estimatedOtherPages = Math.ceil(otherWords / 430);
  return {
    pages: Math.max(1, realPdfPages + estimatedOtherPages),
    realPdfPages,
    estimated: estimatedOtherPages > 0
  };
}

function studyProfile() {
  const size = analysisSizeInfo();
  const pages = size.pages;

  let profile =
    pages <= 5  ? {summaryUnits:3, paragraphs:2, points:6, questions:5, branches:3} :
    pages <= 15 ? {summaryUnits:6, paragraphs:3, points:8, questions:7, branches:4} :
    pages <= 30 ? {summaryUnits:9, paragraphs:4, points:10, questions:9, branches:5} :
    pages <= 60 ? {summaryUnits:12, paragraphs:5, points:12, questions:11, branches:6} :
                  {summaryUnits:16, paragraphs:6, points:15, questions:14, branches:6};

  const purpose = state.studyPurpose || "understand";

  if (purpose === "quick") {
    profile.summaryUnits = Math.max(2, Math.ceil(profile.summaryUnits * .55));
    profile.paragraphs = Math.max(1, Math.ceil(profile.paragraphs * .6));
    profile.points = Math.max(4, profile.points - 3);
    profile.questions = Math.max(3, profile.questions - 3);
    profile.branches = Math.max(3, profile.branches - 1);
  } else if (purpose === "review") {
    profile.points += 2;
    profile.questions += 2;
  } else if (purpose === "exam") {
    profile.questions += 4;
    profile.points += 1;
  } else if (purpose === "deep") {
    profile.summaryUnits += 4;
    profile.paragraphs += 2;
    profile.points += 4;
    profile.questions += 4;
    profile.branches = Math.min(6, profile.branches + 1);
  } else {
    profile.summaryUnits += 2;
    profile.paragraphs += 1;
  }

  return {...profile, pages, purpose, ...size};
}

function purposeLabel(value) {
  return ({
    understand:"Entender bien el tema",
    review:"Repasar",
    exam:"Preparar una prueba",
    quick:"Resumen rápido",
    deep:"Estudiar en profundidad"
  })[value] || "Entender bien el tema";
}

function renderStudyPlan() {
  const card = $("studyPlanCard");
  if (!card) return;

  const active = state.materialSources.filter(source => source.enabled !== false);
  if (!active.length) {
    $("studyPlanTitle").textContent = "Agregá material para calcularlo";
    $("studyPlanDetails").textContent =
      "La cantidad de resumen, conceptos y preguntas se adapta al tamaño del material.";
    return;
  }

  const profile = studyProfile();
  const pageText = profile.realPdfPages
    ? profile.realPdfPages + (profile.realPdfPages === 1 ? " página PDF" : " páginas PDF")
    : "aprox. " + profile.pages + (profile.pages === 1 ? " página" : " páginas");

  $("studyPlanTitle").textContent = pageText + " · " + purposeLabel(profile.purpose);
  $("studyPlanDetails").textContent =
    profile.paragraphs + " bloques de resumen · "
    + profile.points + " puntos clave · "
    + profile.questions + " preguntas con respuesta · "
    + profile.branches + " conceptos principales.";
}

function createSummary(units, profile=studyProfile()) {
  const useful = units
    .map(polishSentence)
    .filter(unit => words(unit).length >= 4);

  if (!useful.length) return "";
  if (useful.length === 1) return useful[0];

  const fullText = useful.join(" ");
  const weights = new Map(keywordData(fullText, 30).map(k => [k.word, k.count]));

  const scored = useful.map((unit,index) => ({
    unit,
    index,
    score: words(unit).reduce((sum,w) => sum + (weights.get(w) || 0), 0)
      / Math.max(1, words(unit).length)
  }));

  const take = Math.min(useful.length, Math.max(2, profile.summaryUnits || 4));
  const selected = scored
    .sort((a,b) => b.score - a.score)
    .slice(0, take)
    .sort((a,b) => a.index - b.index)
    .map(x => x.unit);

  const paragraphCount = Math.min(
    selected.length,
    Math.max(1, profile.paragraphs || 2)
  );
  const perParagraph = Math.ceil(selected.length / paragraphCount);
  const paragraphs = [];

  for (let i = 0; i < selected.length; i += perParagraph) {
    paragraphs.push(selected.slice(i, i + perParagraph).join(" "));
  }

  return paragraphs.join("\n\n");
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

function mapSimilarity(aText, bText) {
  const a = new Set(words(aText));
  const b = new Set(words(bText));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter(x => b.has(x)).length;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

function mapUnitScore(unit, keywordSet, frequency) {
  const unitWords = words(unit);
  if (!unitWords.length) return 0;

  const unique = [...new Set(unitWords)];
  const keywordHits = unique.filter(w => keywordSet.has(w)).length;
  const repetition = unique.reduce((sum, w) => sum + (frequency.get(w) || 0), 0);
  const lengthBonus = Math.min(1, unique.length / 15);

  return keywordHits * 1.6 + repetition * .12 + lengthBonus;
}

function buildMapData(units, topic, branchTarget=studyProfile().branches) {
  const usable = units
    .map(unit => String(unit || "").trim())
    .filter(unit => words(unit).length >= 3);

  if (usable.length < 2) return null;

  const allText = usable.join(" ");
  const keywordPool = keywordData(allText, 36);
  if (keywordPool.length < 2) return null;

  const frequency = new Map(keywordPool.map(k => [k.word, k.count]));
  const keywordSet = new Set(keywordPool.map(k => k.word));
  const desiredBranches = Math.max(2, Math.min(6, branchTarget || 4));

  const branches = [];

  for (const candidate of keywordPool) {
    if (branches.length >= desiredBranches) break;

    const matches = usable.filter(unit => words(unit).includes(candidate.word));
    if (!matches.length) continue;

    const ranked = matches
      .map(unit => ({unit, score:mapUnitScore(unit, keywordSet, frequency)}))
      .sort((a,b) => b.score - a.score);

    const evidence = polishSentence(ranked[0]?.unit || matches[0]);

    const conceptTooSimilar = branches.some(branch =>
      mapSimilarity(branch.word, candidate.label) > .7 ||
      mapSimilarity(branch.evidence, evidence) > .66
    );
    if (conceptTooSimilar) continue;

    const relatedCounts = new Map();
    for (const unit of matches) {
      for (const w of words(unit)) {
        if (w === candidate.word || !keywordSet.has(w)) continue;
        relatedCounts.set(w, (relatedCounts.get(w) || 0) + (frequency.get(w) || 1));
      }
    }

    const related = [...relatedCounts.entries()]
      .sort((a,b) => b[1] - a[1])
      .map(([key]) => prettyConcept(originalWordForKey(allText, key)))
      .filter(label => !branches.some(branch => norm(branch.word) === norm(label)))
      .slice(0, 3);

    const secondaryEvidence = ranked
      .slice(1)
      .map(item => polishSentence(item.unit))
      .find(unit => mapSimilarity(unit, evidence) < .58);

    branches.push({
      word: prettyConcept(candidate.label),
      evidence,
      secondaryEvidence: secondaryEvidence || "",
      links: related
    });
  }

  if (branches.length < 2) {
    const fallback = usable
      .slice(0, Math.min(desiredBranches, usable.length))
      .map((unit,index) => {
        const localKeys = keywordData(unit, 5);
        return {
          word: localKeys[0]?.label || ("Idea " + (index + 1)),
          evidence: polishSentence(unit),
          secondaryEvidence: "",
          links: localKeys.slice(1,4).map(k => k.label)
        };
      });

    return {topic:prettyConcept(topic), branches:fallback};
  }

  return {topic:prettyConcept(topic), branches};
}

function shortenMapEvidence(text, maxWords=22) {
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

function mapWrapLines(ctx, text, maxWidth, maxLines=5) {
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

function mapDrawCenteredText(ctx, text, x, y, maxWidth, lineHeight, maxLines=5) {
  const lines = mapWrapLines(ctx, text, maxWidth, maxLines);
  const totalHeight = Math.max(0, (lines.length - 1) * lineHeight);
  const startY = y - totalHeight / 2;
  lines.forEach((line, index) => ctx.fillText(line, x, startY + index * lineHeight));
}

function mapDrawArrow(ctx, x1, y1, x2, y2, color="#8691a7", width=3, head=12) {
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
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function mapDrawChip(ctx, text, centerX, y, maxWidth) {
  ctx.font = "600 12px Arial, sans-serif";
  const measured = Math.min(maxWidth, ctx.measureText(text).width + 24);
  const x = centerX - measured / 2;
  const h = 28;

  mapRoundRect(ctx, x, y, measured, h, 14);
  ctx.fillStyle = "#f1efff";
  ctx.fill();

  ctx.strokeStyle = "#ded9ff";
  ctx.lineWidth = 1;
  mapRoundRect(ctx, x, y, measured, h, 14);
  ctx.stroke();

  ctx.fillStyle = "#6656b8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, centerX, y + h / 2 + 1);
}

function drawConceptMapToCanvas(canvas, mapData, options={}) {
  const scale = options.scale || 2;
  const responsive = options.responsive !== false;
  const branches = mapData.branches.slice(0, 6);
  const count = branches.length;

  const logicalWidth = 1080;
  const columns = Math.min(3, Math.max(1, count));
  const rows = Math.ceil(count / 3);
  const cardW = 300;
  const cardH = 250;
  const rowGap = 105;
  const logicalHeight = 245 + rows * (cardH + rowGap) + 35;

  canvas.width = logicalWidth * scale;
  canvas.height = logicalHeight * scale;
  canvas.style.width = logicalWidth + "px";
  canvas.style.height = logicalHeight + "px";
  canvas.style.maxWidth = "none";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const background = ctx.createLinearGradient(0, 0, logicalWidth, logicalHeight);
  background.addColorStop(0, "#ffffff");
  background.addColorStop(1, "#f7f8fc");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "700 13px Arial, sans-serif";
  ctx.fillText("MAPA CONCEPTUAL", logicalWidth / 2, 28);

  const centerX = logicalWidth / 2;
  const topic = prettyConcept(mapData.topic);
  const topicW = Math.min(500, Math.max(350, topic.length * 11 + 90));
  const topicH = 96;
  const topicY = 62;
  const topicX = centerX - topicW / 2;

  ctx.save();
  ctx.shadowColor = "rgba(91,70,180,.18)";
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 9;
  mapRoundRect(ctx, topicX, topicY, topicW, topicH, 28);
  const tg = ctx.createLinearGradient(topicX, topicY, topicX + topicW, topicY + topicH);
  tg.addColorStop(0, "#7c5cff");
  tg.addColorStop(1, "#5f44d4");
  ctx.fillStyle = tg;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#fff";
  ctx.font = "700 25px Arial, sans-serif";
  mapDrawCenteredText(ctx, topic, centerX, topicY + topicH / 2 + 1, topicW - 54, 28, 3);

  const rootY = topicY + topicH;
  const firstRowY = 240;

  branches.forEach((branch,index) => {
    const row = Math.floor(index / 3);
    const rowItems = Math.min(3, count - row * 3);
    const col = index % 3;
    const gap = rowItems === 1 ? 0 : 350;
    const rowCenter = centerX;
    const x = rowItems === 1
      ? rowCenter
      : rowCenter - ((rowItems - 1) * gap) / 2 + col * gap;
    const y = firstRowY + row * (cardH + rowGap);

    const elbowY = row === 0 ? 195 : y - 48;
    ctx.save();
    ctx.strokeStyle = "#8e99aa";
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(centerX, rootY);
    ctx.lineTo(centerX, elbowY);
    ctx.lineTo(x, elbowY);
    ctx.stroke();
    ctx.restore();
    mapDrawArrow(ctx, x, elbowY, x, y - 12, "#8e99aa", 2.6, 12);

    const cardX = x - cardW / 2;

    ctx.save();
    ctx.shadowColor = "rgba(15,23,42,.09)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 7;
    mapRoundRect(ctx, cardX, y, cardW, cardH, 24);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#dce1eb";
    ctx.lineWidth = 2;
    mapRoundRect(ctx, cardX, y, cardW, cardH, 24);
    ctx.stroke();

    const bubbleW = cardW - 36;
    const bubbleH = 58;
    const bubbleX = x - bubbleW / 2;
    const bubbleY = y + 18;

    const bg = ctx.createLinearGradient(bubbleX, bubbleY, bubbleX + bubbleW, bubbleY + bubbleH);
    bg.addColorStop(0, "#eeefff");
    bg.addColorStop(1, "#e6e8ff");
    mapRoundRect(ctx, bubbleX, bubbleY, bubbleW, bubbleH, 18);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = "#a09cf0";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#3d3676";
    ctx.font = "700 18px Arial, sans-serif";
    mapDrawCenteredText(ctx, prettyConcept(branch.word), x, bubbleY + bubbleH / 2, bubbleW - 28, 20, 2);

    ctx.fillStyle = "#8590a1";
    ctx.font = "700 10px Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("IDEA PRINCIPAL", cardX + 24, y + 103);

    ctx.textAlign = "center";
    ctx.fillStyle = "#344054";
    ctx.font = "14px Arial, sans-serif";
    mapDrawCenteredText(
      ctx,
      polishSentence(branch.evidence),
      x,
      y + 150,
      cardW - 42,
      19,
      5
    );

    if (branch.links?.length) {
      ctx.fillStyle = "#f0f1f5";
      ctx.fillRect(cardX + 24, y + cardH - 54, cardW - 48, 1);
      ctx.fillStyle = "#7f8998";
      ctx.font = "600 11px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        "Relacionado: " + branch.links.map(prettyConcept).join(" · "),
        x,
        y + cardH - 27
      );
    }
  });

  ctx.fillStyle = "#a6adba";
  ctx.font = "12px Arial, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("EscuchaMapa", logicalWidth - 28, logicalHeight - 18);

  return {logicalWidth, logicalHeight};
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

  drawConceptMapToCanvas(canvas, mapData, { scale: 2, responsive: true });
  state.currentMapCanvas = canvas;
}

function updateInsights(showFeedback=false) {
  const units = analysisUnits();
  const fullText = units.join(" ");
  const keywords = keywordData(fullText, 12);
  const manual = state.analysisMode === "listen" ? $("topicInput").value.trim() : "";
  const profile = studyProfile();

  state.currentProfile = profile;
  $("analysisSourceLabel").textContent = analysisSourceName();

  $("keywords").innerHTML = keywords.length
    ? keywords.map(item => '<span class="chip">' + esc(item.label) + '</span>').join("")
    : '<span class="history-empty">Sin conceptos todavía.</span>';

  const topic = manual
    || keywords.slice(0,3).map(item => item.label).join(" · ")
    || "Tema principal";

  $("detectedTopic").textContent = prettyConcept(
    manual || keywords.slice(0,3).map(item => item.label).join(" · ")
    || "Todavía no hay suficiente texto"
  );

  const summaryText = createSummary(units, profile) || "Todavía no hay suficiente texto.";
  state.currentSummary = summaryText;
  $("summary").textContent = summaryText;

  const mapData = buildMapData(units, topic, profile.branches);
  renderConceptMap(mapData);

  const detectedLanguage = updateLanguageTools(fullText);
  const study = buildStudyData(mapData, detectedLanguage, units, profile);
  renderStudy(study);

  state.showingTranslation = false;
  $("showOriginalMapBtn").classList.add("hidden");

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
  state.analysisMode = "listen";
  state.showingTranslation = false;

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


const MATERIAL_DB_NAME = "escuchamapa-materials-v1";
const MATERIAL_STORE = "sources";

function openMaterialDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MATERIAL_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MATERIAL_STORE)) {
        db.createObjectStore(MATERIAL_STORE, {keyPath:"id"});
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistMaterialSources() {
  try {
    const db = await openMaterialDb();
    const tx = db.transaction(MATERIAL_STORE, "readwrite");
    const store = tx.objectStore(MATERIAL_STORE);
    store.clear();
    state.materialSources.forEach(source => store.put(source));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("No pude guardar el material:", error);
  }
}

async function restoreMaterialSources() {
  try {
    const db = await openMaterialDb();
    const tx = db.transaction(MATERIAL_STORE, "readonly");
    const request = tx.objectStore(MATERIAL_STORE).getAll();
    const sources = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    state.materialSources = sources;
    renderMaterialSources();
  } catch (error) {
    console.warn("No pude recuperar el material:", error);
  }
}

function materialIcon(type) {
  if (type === "pdf") return "PDF";
  if (type === "docx") return "DOCX";
  if (type === "text") return "TEXTO";
  return type.toUpperCase();
}

function renderMaterialSources() {
  const list = $("materialSourcesList");
  const count = state.materialSources.length;
  $("materialCount").textContent = count + (count === 1 ? " fuente" : " fuentes");

  if (!count) {
    list.innerHTML = '<div class="empty-material">Todavía no agregaste material.</div>';
    return;
  }

  list.innerHTML = "";

  for (const source of state.materialSources) {
    const row = document.createElement("div");
    row.className = "material-source" + (source.enabled === false ? " disabled" : "");
    row.innerHTML =
      '<label class="source-toggle"><input type="checkbox" ' + (source.enabled === false ? "" : "checked") + '><span></span></label>'
      + '<div class="source-type">' + esc(materialIcon(source.type || "text")) + '</div>'
      + '<div class="source-info"><strong>' + esc(source.name) + '</strong>'
      + '<small>' + (source.type === "pdf" && source.pageCount
        ? source.pageCount + (source.pageCount === 1 ? " página" : " páginas")
        : (source.pageCount ? "≈ " + source.pageCount + (source.pageCount === 1 ? " página" : " páginas") : source.text.length.toLocaleString() + " caracteres"))
      + '</small></div>'
      + '<button class="ghost source-remove">Quitar</button>';

    row.querySelector("input").onchange = event => {
      source.enabled = event.target.checked;
      row.classList.toggle("disabled", !source.enabled);
      persistMaterialSources();
      renderStudyPlan();
    };

    row.querySelector(".source-remove").onclick = async () => {
      state.materialSources = state.materialSources.filter(item => item.id !== source.id);
      await persistMaterialSources();
      renderMaterialSources();
      renderStudyPlan();
      if (state.analysisMode === "material") updateInsights();
    };

    list.appendChild(row);
  }
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("PDF.js no está disponible");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({data:buffer}).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(" ").trim();
    if (text) pages.push(text);
  }

  return {text:pages.join("\n\n"), pageCount:pdf.numPages};
}

async function extractDocxText(file) {
  if (!window.mammoth?.extractRawText) throw new Error("Mammoth no está disponible");
  const buffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({arrayBuffer:buffer});
  return result.value || "";
}

async function extractFileText(file) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";

  if (extension === "pdf") {
    const result = await extractPdfText(file);
    return {type:"pdf", text:result.text, pageCount:result.pageCount};
  }

  if (extension === "docx") {
    const text = await extractDocxText(file);
    return {type:"docx", text, pageCount:Math.max(1, Math.ceil(words(text, true).length / 430))};
  }

  const raw = await file.text();

  if (extension === "html" || extension === "htm") {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    const text = doc.body?.innerText || "";
    return {type:"html", text, pageCount:Math.max(1, Math.ceil(words(text, true).length / 430))};
  }

  return {
    type:extension || "text",
    text:raw,
    pageCount:Math.max(1, Math.ceil(words(raw, true).length / 430))
  };
}

async function addFilesAsMaterials(files) {
  const selected = [...files];
  if (!selected.length) return;

  $("materialImportStatus").classList.remove("hidden");
  $("materialImportStatus").textContent = "Leyendo " + selected.length + (selected.length === 1 ? " archivo…" : " archivos…");

  let added = 0;
  const errors = [];

  for (const file of selected) {
    try {
      const result = await extractFileText(file);
      const text = String(result.text || "").trim();

      if (!text) throw new Error("No encontré texto dentro del archivo");

      state.materialSources.push({
        id: crypto.randomUUID?.() || (Date.now() + "-" + Math.random()),
        name: file.name,
        type: result.type,
        text,
        pageCount: result.pageCount || Math.max(1, Math.ceil(words(text, true).length / 430)),
        enabled: true,
        addedAt: Date.now()
      });
      added++;
    } catch (error) {
      errors.push(file.name);
      console.warn("No pude importar", file.name, error);
    }
  }

  await persistMaterialSources();
  renderMaterialSources();
  renderStudyPlan();

  $("materialImportStatus").textContent =
    added + (added === 1 ? " archivo agregado" : " archivos agregados")
    + (errors.length ? ". No pude leer: " + errors.join(", ") : ".");

  $("materialFilesInput").value = "";
}

async function addManualMaterial() {
  const text = $("materialTextInput").value.trim();
  if (!text) {
    alert("Pegá o escribí un texto primero.");
    return;
  }

  const title = $("materialTitleInput").value.trim() || "Texto " + (state.materialSources.length + 1);

  state.materialSources.push({
    id: crypto.randomUUID?.() || String(Date.now()),
    name: title,
    type: "text",
    text,
    pageCount: Math.max(1, Math.ceil(words(text, true).length / 430)),
    enabled: true,
    addedAt: Date.now()
  });

  $("materialTitleInput").value = "";
  $("materialTextInput").value = "";

  await persistMaterialSources();
  renderMaterialSources();
  renderStudyPlan();
  toast("Texto agregado");
}

async function clearMaterials() {
  if (!state.materialSources.length) return;
  if (!confirm("¿Quitar todo el material cargado?")) return;

  state.materialSources = [];
  await persistMaterialSources();
  renderMaterialSources();
  renderStudyPlan();

  if (state.analysisMode === "material") {
    state.analysisMode = "listen";
    updateInsights();
  }
}

function analyzeMaterials() {
  const active = state.materialSources.filter(source => source.enabled !== false);
  if (!active.length) {
    alert("Agregá al menos una fuente para analizar.");
    return;
  }

  state.analysisMode = "material";
  state.showingTranslation = false;
  $("topicInput").value = "";
  updateInsights(true);
  setAppView("study");
  toast(active.length === 1 ? "Material analizado" : "Fuentes combinadas y analizadas");
}

function setAppView(viewName) {
  document.querySelectorAll(".app-view").forEach(view => {
    view.classList.toggle("hidden", view.id !== "view-" + viewName);
    view.classList.toggle("active", view.id === "view-" + viewName);
  });

  document.querySelectorAll(".workspace-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });

  if (viewName === "study") updateInsights();
  if (viewName === "material") renderMaterialSources();
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
  if (!data || !data.branches?.length) {
    alert("Todavía no hay suficiente contenido para descargar un mapa.");
    return;
  }

  const exportCanvas = document.createElement("canvas");
  drawConceptMapToCanvas(exportCanvas, data, { scale: 3, responsive: false });

  exportCanvas.toBlob(blob => {
    if (!blob) {
      alert("No pude generar la imagen del mapa.");
      return;
    }

    downloadBlob(blob, safeFilename(data.topic || "mapa-conceptual", "png"));
    toast("Mapa PNG descargado");
  }, "image/png", 1);
}


function visibleStudyData() {
  return state.showingTranslation && state.translatedStudy
    ? state.translatedStudy
    : state.currentStudy;
}

function visibleSummaryText() {
  return state.showingTranslation && state.translatedSummary
    ? state.translatedSummary
    : state.currentSummary;
}

function buildStudyDocumentText() {
  const study = visibleStudyData() || {points:[],questions:[]};
  const questions = study.questions || [];
  const lines = [
    "ESCUCHAMAPA",
    "",
    "TEMA",
    $("detectedTopic").textContent,
    "",
    "OBJETIVO",
    purposeLabel(state.currentProfile?.purpose || state.studyPurpose),
    "",
    "RESUMEN",
    visibleSummaryText(),
    "",
    "PUNTOS CLAVE"
  ];

  study.points.forEach((point,index) => lines.push((index + 1) + ". " + point));

  lines.push("", "PREGUNTAS Y RESPUESTAS");
  questions.forEach((item,index) => {
    lines.push(
      (index + 1) + ". " + (item.question || item),
      "Respuesta: " + (item.answer || ""),
      ""
    );
  });

  return lines.join("\n");
}

function exportStudyTxt() {
  const text = buildStudyDocumentText();
  downloadBlob(
    new Blob([text], {type:"text/plain;charset=utf-8"}),
    safeFilename($("detectedTopic").textContent || "EscuchaMapa-estudio", "txt")
  );
  toast("TXT descargado");
}

function exportStudyDoc() {
  const study = visibleStudyData() || {points:[],questions:[]};
  const html =
    '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>body{font-family:Arial,sans-serif;line-height:1.5;color:#222;margin:40px}'
    + 'h1{font-size:24px}h2{font-size:18px;margin-top:26px}li{margin:7px 0}'
    + '.answer{margin:4px 0 12px 18px;color:#444}</style></head><body>'
    + '<h1>EscuchaMapa</h1>'
    + '<h2>' + esc($("detectedTopic").textContent) + '</h2>'
    + '<p><strong>Objetivo:</strong> ' + esc(purposeLabel(state.currentProfile?.purpose || state.studyPurpose)) + '</p>'
    + '<h2>Resumen</h2><p>' + esc(visibleSummaryText()).replace(/\n\n/g,"</p><p>") + '</p>'
    + '<h2>Puntos clave</h2><ol>'
    + study.points.map(point => '<li>' + esc(point) + '</li>').join("")
    + '</ol><h2>Preguntas y respuestas</h2><ol>'
    + (study.questions || []).map(item =>
        '<li><strong>' + esc(item.question || item) + '</strong>'
        + '<div class="answer">Respuesta: ' + esc(item.answer || "") + '</div></li>'
      ).join("")
    + '</ol></body></html>';

  downloadBlob(
    new Blob(["\ufeff", html], {type:"application/msword;charset=utf-8"}),
    safeFilename($("detectedTopic").textContent || "EscuchaMapa-estudio", "doc")
  );
  toast("Word descargado");
}

function exportStudyPdf() {
  if (!window.jspdf?.jsPDF) {
    alert("No se pudo cargar el generador de PDF.");
    return;
  }

  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({unit:"mm",format:"a4"});
  const margin = 18;
  const width = 210 - margin * 2;
  const pageBottom = 279;
  let y = 20;

  const write = (text,size=10.5,bold=false,gap=3) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const paragraphs = String(text || "").split(/\n{2,}/);

    for (const paragraph of paragraphs) {
      const lines = doc.splitTextToSize(paragraph, width);
      for (const line of lines) {
        if (y > pageBottom) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, margin, y);
        y += size * .42 + 1.7;
      }
      y += 2;
    }
    y += gap;
  };

  const study = visibleStudyData() || {points:[],questions:[]};

  write("EscuchaMapa",18,true,2);
  write($("detectedTopic").textContent,14,true,5);
  write("Objetivo: " + purposeLabel(state.currentProfile?.purpose || state.studyPurpose),10,false,5);
  write("Resumen",12,true,2);
  write(visibleSummaryText(),10.5,false,5);

  write("Puntos clave",12,true,2);
  study.points.forEach((point,index) => write((index + 1) + ". " + point,10,false,1));

  write("Preguntas y respuestas",12,true,2);
  (study.questions || []).forEach((item,index) => {
    write((index + 1) + ". " + (item.question || item),10.5,true,1);
    write("Respuesta: " + (item.answer || ""),10,false,2);
  });

  doc.save(safeFilename($("detectedTopic").textContent || "EscuchaMapa-estudio","pdf"));
  toast("PDF descargado");
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
document.querySelectorAll(".workspace-tab").forEach(button => {
  button.onclick = () => setAppView(button.dataset.view);
});
$("addMaterialTextBtn").onclick = addManualMaterial;
$("chooseMaterialFilesBtn").onclick = () => $("materialFilesInput").click();
$("materialFilesInput").onchange = event => addFilesAsMaterials(event.target.files);
$("clearMaterialsBtn").onclick = clearMaterials;
$("analyzeMaterialsBtn").onclick = analyzeMaterials;
$("studyPurposeSelect").onchange = () => {
  state.studyPurpose = $("studyPurposeSelect").value;
  renderStudyPlan();
  if (state.analysisMode === "material") updateInsights();
};
$("exportStudyPdfBtn").onclick = exportStudyPdf;
$("exportStudyDocBtn").onclick = exportStudyDoc;
$("exportStudyTxtBtn").onclick = exportStudyTxt;

$("materialDropzone").ondragover = event => {
  event.preventDefault();
  $("materialDropzone").classList.add("dragging");
};
$("materialDropzone").ondragleave = () => $("materialDropzone").classList.remove("dragging");
$("materialDropzone").ondrop = event => {
  event.preventDefault();
  $("materialDropzone").classList.remove("dragging");
  addFilesAsMaterials(event.dataTransfer.files);
};
$("translateGeneratedBtn").onclick = translateGeneratedContent;
$("showOriginalMapBtn").onclick = showOriginalAnalysis;
$("copyStudyBtn").onclick = copyStudyMaterial;

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
  state.analysisMode = "listen";
  state.showingTranslation = false;
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
restoreMaterialSources().then(() => {
  $("studyPurposeSelect").value = state.studyPurpose;
  renderStudyPlan();
});
renderRaw();
renderHistory();
updateInsights();
updateUI();