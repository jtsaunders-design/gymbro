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

// Sound switch: the ping and spoken replies. Remembered on this device.
const SOUND_KEY = "gymbro.sound";
let soundOn = true;
try {
  soundOn = localStorage.getItem(SOUND_KEY) !== "off";
} catch {
  // storage blocked: default to sound on
}

// ---------- logging + UI ----------

function log(msg) {
  console.log(`[gymbro] ${msg}`);
}

function setStartButton(on) {
  $("start").classList.toggle("on", on);
  $("start").setAttribute("aria-checked", String(on));
  $("startLabel").textContent = on ? "Mic on" : "Mic off";
}

function setSoundButton(on) {
  $("speaker").classList.toggle("on", on);
  $("speaker").setAttribute("aria-checked", String(on));
  $("speakerLabel").textContent = on ? "Sound on" : "Sound off";
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
  if (!soundOn) return;
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
  if (!soundOn) return;
  if (!("speechSynthesis" in window)) return log("speechSynthesis not supported");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

async function keepAwake() {
  if (!("wakeLock" in navigator)) return log("wake lock not supported");
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    log("wake lock on");
  } catch (e) {
    log(`wake lock failed (${e.name})`);
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
// `direct` input (typed sets) doesn't need the wake word, like hold-to-talk.
function extractCommand(phrase, direct = false) {
  if (holdToTalk || direct) return stripWake(phrase) || null;
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

function handlePhrase(phrase, source, direct = false) {
  log(`heard (${source}): "${phrase}"`);
  if (answerWeight(phrase, source)) return;
  const heard = extractCommand(phrase, direct);
  if (!heard) {
    if (Date.now() >= awaitingCommandUntil && wantListening && !pendingWeight) setState("listening", "Listening", 'Say "GymBro, …"');
    return;
  }
  awaitingCommandUntil = 0;
  pendingWeight = null;
  const command = correctMishearings(heard);
  showCommand(command, command === heard ? source : `${source} · heard "${heard}"`);

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
      setState("error", "Mic blocked", "Allow microphone access for this site, then turn the mic on");
      setStartButton(false);
    }
  };

  // Android Chrome ends the session after silence; restart unless we meant to stop.
  r.onend = () => {
    log("recognizer ended");
    if (!wantListening && !holdToTalk) return;
    restarts++;
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

setSoundButton(soundOn);
$("speaker").addEventListener("click", () => {
  soundOn = !soundOn;
  setSoundButton(soundOn);
  try {
    localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  } catch {
    // storage blocked: the switch still works for this visit
  }
  ping(); // a quick confirmation when turning sound on
});

if (SpeechRecognition) {
  recognizer = buildRecognizer();
  $("talk").disabled = false;
} else {
  $("start").disabled = true;
  setState("error", "No speech support", "Open this page in Chrome. You can still type a set.");
}

function toggleMic() {
  if ($("start").disabled) return;
  audioCtx ??= new AudioContext(); // must be created from a tap or key press
  audioCtx.resume();
  if (wantListening) {
    wantListening = false;
    recognizer.stop();
    setStartButton(false);
    setState("idle", "Paused", "Turn the mic on to listen again");
    return;
  }
  wantListening = true;
  setStartButton(true);
  setState("listening", "Listening", 'Say "GymBro, …"');
  keepAwake();
  startRecognizer();
}

$("start").addEventListener("click", toggleMic);

// Keyboard: Space (or Cmd/Ctrl+Space where the OS allows it) turns the mic on or off.
// Skipped while typing or editing a set, and handled on keyup too so a focused button doesn't also fire.
const isTyping = (el) => el?.closest?.("input, textarea, select, [contenteditable], dialog");
const isMicKey = (e) => e.code === "Space" && !e.altKey && !e.shiftKey;
document.addEventListener("keydown", (e) => {
  if (!isMicKey(e) || isTyping(e.target)) return;
  e.preventDefault();
  if (!e.repeat) toggleMic();
});
document.addEventListener("keyup", (e) => {
  if (isMicKey(e) && !isTyping(e.target)) e.preventDefault();
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
  handlePhrase(text, "typed", true);
  $("typedText").value = "";
});

// Landing-page screenshots: ?demo=listening | logged | weight | edit
if (DEMO === "listening") {
  setStartButton(true);
  setState("listening", "Listening", 'Say "GymBro, …"');
} else if (DEMO === "logged") {
  setStartButton(true);
  showCommand("bench press 60 kg going for 8 got 8 barbell", "voice");
  setState("logged", "Logged Bench press", "60 kg · 8 / 8 reps · barbell");
} else if (DEMO === "weight") {
  setStartButton(true);
  setState("awake", "What weight?", 'Row: say the weight, or "skip"');
} else if (DEMO === "edit") {
  openEditor(diary.at(-1).id);
}

log("page loaded");
