// GymBro voice spike: always-on listening, wake word, ping, wake lock.
// Answers the step-1 questions from the PRD on a real Android phone.

const $ = (id) => document.getElementById(id);

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// "GymBro" gets misheard a lot, so accept the common variants.
const WAKE_SRC = String.raw`\b(?:(?:hey|hi|ok|okay)[,.]?\s+)?(?:(?:gym|jim|gim|jym|jem|gem)\s*-?\s*(?:bro|bros|bro's|brow|bra|brah|bruh|brother)|gymbo|jimbo)\b[,.!?]*\s*`;
const WAKE = new RegExp(WAKE_SRC, "i");
const WAKE_ALL = new RegExp(WAKE_SRC, "gi");
const MAX_WORDS_BEFORE_WAKE = 2; // allows "okay so GymBro…", ignores chatter that mentions a gym bro mid-sentence
const FOLLOW_UP_MS = 6000; // after a bare "GymBro", the next phrase counts as the command

let recognizer = null;
let wantListening = false;
let holdToTalk = false;
let awaitingCommandUntil = 0;
let restarts = 0;
let lastStart = 0;
let wakeLock = null;
let audioCtx = null;

// ---------- logging + UI ----------

function log(msg) {
  console.log(`[gymbro] ${msg}`);
}

function setState(kind, text, hint) {
  $("status").className = `status ${kind}`;
  $("state").textContent = text;
  if (hint !== undefined) $("hint").textContent = hint;
}

function showCommand(text, source) {
  const list = $("commands");
  list.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  li.textContent = text;
  const meta = document.createElement("small");
  meta.textContent = `${source} · ${new Date().toLocaleTimeString()}`;
  li.append(meta);
  list.prepend(li);
}

// ---------- feedback ----------

function ping() {
  audioCtx ??= new AudioContext();
  const now = audioCtx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.4, now + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + i * 0.12);
    osc.stop(now + i * 0.12 + 0.2);
  });
}

function speak(text) {
  if (!("speechSynthesis" in window)) return log("speechSynthesis not supported");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

async function keepAwake() {
  if (!("wakeLock" in navigator)) {
    $("fWake").textContent = "not supported";
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    $("fWake").textContent = "on";
    wakeLock.addEventListener("release", () => ($("fWake").textContent = "released"));
  } catch (e) {
    $("fWake").textContent = `failed (${e.name})`;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wantListening) keepAwake();
});

// ---------- command handling ----------

// Removes every mention of the wake word so it never ends up in the diary.
function stripWake(text) {
  return text.replace(WAKE_ALL, " ").replace(/^[\s,.!?]+|[\s,]+$/g, "").replace(/\s+/g, " ");
}

// Returns the command text if this phrase is addressed to GymBro, else null.
function extractCommand(phrase) {
  if (holdToTalk) return stripWake(phrase) || null;
  const m = phrase.match(WAKE);
  const wordsBefore = m ? phrase.slice(0, m.index).trim().split(/\s+/).filter(Boolean).length : Infinity;
  if (m && wordsBefore <= MAX_WORDS_BEFORE_WAKE) {
    const rest = stripWake(phrase.slice(m.index + m[0].length));
    if (rest) return rest;
    awaitingCommandUntil = Date.now() + FOLLOW_UP_MS;
    setState("awake", "Yes?", "Listening for your set…");
    log("wake word alone, waiting for command");
    return null;
  }
  if (Date.now() < awaitingCommandUntil) return stripWake(phrase) || null;
  return null;
}

// After "What weight?" the next phrase is the answer, no wake word needed.
const ANSWER_MS = 10000;
const SKIP = /\b(skip|no weight|body ?weight|none|forget it|never ?mind|cancel)\b/i;
let pendingWeight = null; // { entryId, until }

function backToListening(delay = 1800) {
  setTimeout(() => wantListening && !pendingWeight && setState("listening", "Listening", 'Say "GymBro, …"'), delay);
}

function askForWeight(entry) {
  pendingWeight = { entryId: entry.id, until: Date.now() + ANSWER_MS };
  setState("awake", "What weight?", `${entry.exercise}: say the weight, or "skip"`);
  speak("What weight?");
}

// Returns true if the phrase answered the pending "What weight?" question.
function answerWeight(phrase, source) {
  if (!pendingWeight) return false;
  if (Date.now() > pendingWeight.until || diary.at(-1)?.id !== pendingWeight.entryId) {
    pendingWeight = null;
    return false;
  }
  const reply = stripWake(phrase);
  if (SKIP.test(reply)) {
    pendingWeight = null;
    setState("logged", "No weight", "Logged without a weight");
    backToListening();
    return true;
  }
  const norm = normalise(reply);
  if (!/\d/.test(norm)) return false; // not an answer (or our own "What weight?" echoing back): keep waiting
  if (parseFields(norm, reply).known) return false; // a whole new set, not an answer
  const entry = amendLast(reply);
  if (!entry || entry.weight == null) return false;
  pendingWeight = null;
  showCommand(reply, `${source}, answer`);
  ping();
  setState("logged", `Updated ${entry.exercise}`, describe(entry));
  backToListening();
  return true;
}

function handlePhrase(phrase, source) {
  log(`heard (${source}): "${phrase}"`);
  if (answerWeight(phrase, source)) return;
  const command = extractCommand(phrase);
  if (!command) {
    if (Date.now() >= awaitingCommandUntil && wantListening && !pendingWeight) setState("listening", "Listening", 'Say "GymBro, …"');
    return;
  }
  awaitingCommandUntil = 0;
  pendingWeight = null;
  showCommand(command, source);

  if (isAmendment(command)) {
    const entry = amendLast(command);
    if (!entry) {
      setState("error", "Didn't catch that", diary.length ? 'Try "add 20 kg" or "actually got 10"' : "Log a set first");
      backToListening(2500);
      return;
    }
    ping();
    setState("logged", `Updated ${entry.exercise}`, describe(entry));
    if (entry.weight == null && !entry.bodyweight) askForWeight(entry);
    else backToListening();
    return;
  }

  const entry = addToDiary(command);
  ping();
  setState("logged", `Logged ${entry.exercise}`, describe(entry));
  if (entry.weight == null && !entry.bodyweight) askForWeight(entry);
  else backToListening();
}

// ---------- speech recognition ----------

function buildRecognizer() {
  const r = new SpeechRecognition();
  r.lang = "en-GB";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onstart = () => {
    lastStart = Date.now();
    log("recognizer started");
  };

  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript;
      if (res.isFinal) {
        handlePhrase(text, holdToTalk ? "tap" : "voice");
      } else if (WAKE.test(text) && !$("status").classList.contains("awake")) {
        setState("awake", "Hearing you…", text);
      }
    }
  };

  r.onerror = (e) => {
    log(`error: ${e.error}`);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      wantListening = false;
      setState("error", "Mic blocked", "Allow microphone access for this site, then tap Start");
      $("start").textContent = "Start listening";
    }
  };

  // Android Chrome ends the session after silence; restart unless we meant to stop.
  r.onend = () => {
    log("recognizer ended");
    if (!wantListening && !holdToTalk) return;
    restarts++;
    $("fRestarts").textContent = restarts;
    const ranFor = Date.now() - lastStart;
    setTimeout(startRecognizer, ranFor < 1000 ? 1000 : 150); // back off if it keeps dying
  };

  return r;
}

function startRecognizer() {
  if (!wantListening && !holdToTalk) return;
  try {
    recognizer.start();
  } catch (e) {
    // "already started" is harmless
    if (e.name !== "InvalidStateError") log(`start failed: ${e.message}`);
  }
}

// ---------- controls ----------

$("fSpeech").textContent = SpeechRecognition ? "supported" : "NOT supported (use Chrome on Android)";

if (SpeechRecognition) {
  recognizer = buildRecognizer();
  $("talk").disabled = false;
} else {
  $("start").disabled = true;
  setState("error", "No speech support", "Open this page in Chrome. You can still use Type instead.");
}

$("start").addEventListener("click", () => {
  audioCtx ??= new AudioContext(); // must be created from a tap
  audioCtx.resume();
  if (wantListening) {
    wantListening = false;
    recognizer.stop();
    $("start").textContent = "Start listening";
    setState("idle", "Paused", "Tap Start to listen again");
    return;
  }
  wantListening = true;
  $("start").textContent = "Stop";
  setState("listening", "Listening", 'Say "GymBro, …"');
  keepAwake();
  startRecognizer();
});

// Fallback: hold the button and speak, no wake word needed.
const talk = $("talk");
const talkDown = (e) => {
  e.preventDefault();
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  holdToTalk = true;
  talk.classList.add("held");
  setState("awake", "Talk now", "Release when done");
  startRecognizer();
};
const talkUp = () => {
  if (!holdToTalk) return;
  talk.classList.remove("held");
  // give the recognizer a moment to finalise the phrase
  setTimeout(() => {
    holdToTalk = false;
    if (!wantListening) recognizer.stop();
  }, 700);
};
talk.addEventListener("pointerdown", talkDown);
talk.addEventListener("pointerup", talkUp);
talk.addEventListener("pointerleave", talkUp);

$("typed").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("typedText").value.trim();
  if (!text) return;
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  handlePhrase(text, "typed");
  $("typedText").value = "";
});

$("testPing").addEventListener("click", () => {
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  ping();
});
$("testSpeak").addEventListener("click", () => speak("Logged that. You're currently on 25 kilos and your best is 11 reps."));

log("page loaded");
