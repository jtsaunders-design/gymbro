// GymBro diary: turns a spoken set into an entry, stores it, and renders it by day.
// Rule-based parsing for now; Claude takes over in build step 2.

const DIARY_KEY = "gymbro.diary.v1";

// Simple line icons, 24x24, drawn with currentColor.
const ICONS = {
  bench: '<circle cx="5" cy="13" r="2"/><path d="M7 14h11M8 18h12M10 18v3M18 18v3M11 14l1-5M15 14l-1-5M7 9h10M7 7v4M17 7v4"/>',
  overhead: '<circle cx="12" cy="8" r="2"/><path d="M12 10v6M12 16l-3 5M12 16l3 5M12 11l-4-6M12 11l4-6M4 5h16M5 3v4M19 3v4"/>',
  squat: '<circle cx="12" cy="4" r="2"/><path d="M4 8h16M5 6v4M19 6v4M12 6v8M12 14l-4 2 2 5M12 14l4 2-2 5"/>',
  deadlift: '<circle cx="12" cy="4" r="2"/><path d="M12 6v8M12 14l-2 7M12 14l2 7M12 8l-3 9M12 8l3 9M4 17h16M5 15v4M19 15v4"/>',
  pull: '<path d="M3 3h18M8 3l2 7M16 3l-2 7"/><circle cx="12" cy="9" r="2"/><path d="M12 11v6M12 17l-2 4M12 17l2 4"/>',
  row: '<circle cx="6" cy="6" r="2"/><path d="M6 8l1 7h9l3 3M6.5 10H12M12 10h9M19 8v4M4 20h16"/>',
  leg: '<circle cx="7" cy="5" r="2"/><path d="M7 7v7h6l3 6M4 14h5M4 14v7M14 21h5"/>',
  dumbbell: '<path d="M8 12h8"/><rect x="4" y="8" width="4" height="8" rx="1"/><rect x="16" y="8" width="4" height="8" rx="1"/><path d="M2 10v4M22 10v4"/>',
};

// Order matters: specific names before general ones (leg curl before curl, RDL before deadlift).
const EXERCISES = [
  { name: "Incline bench press", re: /incline (bench|press)/, group: "push", icon: "bench" },
  { name: "Leg press", re: /leg press/, group: "legs", icon: "leg" },
  { name: "Overhead press", re: /overhead press|shoulder press|military press|\bohp\b/, group: "push", icon: "overhead" },
  { name: "Chest press", re: /chest press/, group: "push", icon: "bench" },
  { name: "Bench press", re: /bench/, group: "push", icon: "bench" },
  { name: "Push-ups", re: /push ?-?ups?/, group: "push", icon: "bench", bodyweight: true },
  { name: "Dips", re: /\bdips?\b/, group: "push", icon: "overhead", bodyweight: true },
  { name: "Chest fly", re: /\bfl(y|ies)\b|pec deck/, group: "push", icon: "dumbbell" },
  { name: "Lateral raise", re: /lateral|side raise/, group: "push", icon: "dumbbell" },
  { name: "Shoulder raise", re: /shoulder raise/, group: "push", icon: "dumbbell" },
  { name: "Front raise", re: /front raise/, group: "push", icon: "dumbbell" },
  { name: "Triceps", re: /tricep|skull ?crusher|push ?down/, group: "push", icon: "dumbbell" },
  { name: "Face pull", re: /face ?pull/, group: "pull", icon: "row" },
  { name: "Pull-ups", re: /pull ?-?ups?|chin ?-?ups?/, group: "pull", icon: "pull", bodyweight: true },
  { name: "Lat pulldown", re: /pull ?down|lat pull/, group: "pull", icon: "pull" },
  { name: "Row", re: /\brow(s|ing)?\b/, group: "pull", icon: "row" },
  { name: "Leg curl", re: /leg curl|hamstring curl/, group: "legs", icon: "leg" },
  { name: "Hammer curl", re: /hammer curl/, group: "pull", icon: "dumbbell" },
  { name: "Bicep curl", re: /\bcurls?\b|bicep/, group: "pull", icon: "dumbbell" },
  { name: "Shrugs", re: /shrug/, group: "pull", icon: "deadlift" },
  { name: "Romanian deadlift", re: /romanian|\brdl\b|stiff ?-?leg/, group: "legs", icon: "deadlift" },
  { name: "Deadlift", re: /dead ?lift/, group: "pull", icon: "deadlift" },
  { name: "Front squat", re: /front squat/, group: "legs", icon: "squat" },
  { name: "Squat", re: /squat/, group: "legs", icon: "squat" },
  { name: "Lunges", re: /lunge/, group: "legs", icon: "leg" },
  { name: "Leg extension", re: /leg extension/, group: "legs", icon: "leg" },
  { name: "Calf raise", re: /calf|calves/, group: "legs", icon: "leg" },
  { name: "Hip thrust", re: /hip thrust|glute bridge/, group: "legs", icon: "deadlift" },
];

const GROUP_LABEL = { push: "Push", pull: "Pull", legs: "Legs", other: "Other" };

const UNITS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine" };
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function wordsToDigits(text) {
  const units = Object.values(UNITS).join("|");
  return text
    .replace(new RegExp(`\\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[ -](${units})\\b`, "g"),
      (_, tens, unit) => String(NUMBER_WORDS[tens] + NUMBER_WORDS[unit]))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/g,
      (w) => String(NUMBER_WORDS[w]))
    .replace(/\b(\d) 100(?: and)? (\d{1,2})\b/g, (_, h, rest) => String(h * 100 + Number(rest)))
    .replace(/\b(\d) 100\b/g, (_, h) => String(h * 100));
}

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- fixing misheard gym words ----------

// Speech recognisers hear gym words as everyday ones. These are the common swaps.
const MISHEARD = [
  [/\b(razors?|raisers?|rayses|race is)\b/g, "raises"],
  [/\b(lateral|front|side|shoulder|calf) (rays|raids|rays is)\b/g, "$1 raises"],
  [/\b(car|calves|cough|cuff) raises\b/g, "calf raises"],
  [/\bbench (rest|breast|dress|pressed|presses)\b/g, "bench press"],
  [/\b(leg|chest|shoulder|military|overhead) (breast|rest|dress|pressed)\b/g, "$1 press"],
  [/\bchess (press|fly|flies)\b/g, "chest $1"],
  [/\b(squad|squads|squatch)\b/g, "squat"],
  [/\bdead (left|lifts?|list|lifted)\b|\bdeadleft\b/g, "deadlift"],
  [/\b(lap|lad|lot|flat) (pull ?downs?)\b/g, "lat pulldown"],
  [/\b(bicep|biceps|hammer|leg|hamstring) (girls?|curly|curb|curve|carl|curd)\b/g, "$1 curl"],
  [/\b(barbell|dumbbell|cable|seated|bent over|upright) (rose|roads|roes|rolls)\b/g, "$1 rows"],
  [/^(rose|roes)\b/g, "rows"],
  [/\b(lunches|lunge is)\b/g, "lunges"],
  [/\bhip (trust|crust|thrusts)\b/g, "hip thrust"],
  [/\bface (pool|pole|pulls)\b/g, "face pull"],
  [/\b(dibs|dipps)\b/g, "dips"],
  [/\bpull (ops|cups|apps)\b/g, "pull ups"],
  [/\bpush (ops|cups|apps)\b/g, "push ups"],
  [/\bskull (crushes|crashers|crasher)\b/g, "skull crushers"],
  [/\btri ?(step|sep|seps)\b/g, "tricep"],
  [/\b(shrubs|shrug's)\b/g, "shrugs"],
  [/\br d l\b/g, "rdl"],
  [/\bo h p\b/g, "ohp"],
];

// Close-match fallback for anything not in the list ("leg extention", "hamer curl").
const VOCAB = [
  "bench press", "incline bench", "chest press", "overhead press", "shoulder press", "military press",
  "push ups", "dips", "chest fly", "pec deck", "lateral raise", "shoulder raise", "front raise",
  "triceps", "skull crusher", "face pull", "pull ups", "chin ups", "lat pulldown", "rows", "leg curl",
  "hammer curl", "bicep curl", "shrugs", "romanian deadlift", "deadlift", "front squat", "squat",
  "lunges", "leg extension", "leg press", "calf raise", "hip thrust", "glute bridge",
];
const PROTECTED = /^(\d.*|for|got|going|aiming|trying|did|hit|managed|reps?|kg|kgs|kilos?|kilograms?|lbs?|pounds?|x|times|and|but|the|a|on|with|same|again|add|also|actually|that|was|it|barbell|bar|dumbbells?|machine|cable|smith)$/;

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const singular = (s) => s.replace(/s\b/g, "");

function fuzzyFix(text) {
  const words = text.split(" ");
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const slice = words.slice(i, i + size);
      if (slice.some((w) => !w || PROTECTED.test(w))) continue;
      const phrase = slice.join(" ");
      if (phrase.length < 4) continue;
      let best = null;
      for (const v of VOCAB) {
        if (v.split(" ").length !== size) continue;
        const d = singular(phrase) === singular(v) ? 0 : editDistance(phrase, v);
        if (d / v.length <= 0.2 && (!best || d < best.d)) best = { v, d };
      }
      if (best && best.d > 0) words.splice(i, size, ...best.v.split(" "));
    }
  }
  return words.join(" ");
}

// Returns the text with misheard gym words corrected (lowercased), or the original if nothing changed.
function correctMishearings(raw) {
  const before = raw.toLowerCase().replace(/[,!?]|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
  let text = before;
  for (const [wrong, right] of MISHEARD) text = text.replace(wrong, right);
  text = fuzzyFix(text);
  return text === before ? raw : text;
}

function normalise(raw) {
  return wordsToDigits(correctMishearings(raw).toLowerCase().replace(/[,!?]|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim())
    .replace(/(\d+) point (\d+)/g, "$1.$2");
}

function parseSet(raw, last) {
  const text = normalise(raw);

  if (/^(same|again|same again|repeat)\b/.test(text) && last) {
    const override = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|kilograms?|lbs?|pounds?)/);
    return { ...last, weight: override ? Number(override[1]) : last.weight, raw };
  }

  return parseFields(text, raw);
}

// Pulls whatever it can out of normalised text; fields it can't find are null.
function parseFields(text, raw) {
  const ex = EXERCISES.find((e) => e.re.test(text));
  const unitMatch = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|kilograms?|lbs?|pounds?)\b/);
  const target = text.match(/(?:going for|aiming for|target(?: of)?|trying for)\s*(\d+)/);
  const got = text.match(/(?:got|did|managed|hit)\s*(\d+)|(\d+)\s*reps?\b/);
  const forReps = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilos?|lbs?|pounds?)?\s*(?:for|x|times)\s*(\d+)/);
  const equipment = text.match(/\b(barbell|bar|dumbbells?|machine|cable|smith)\b/);

  let weight = unitMatch ? Number(unitMatch[1]) : null;
  let reps = got ? Number(got[1] ?? got[2]) : null;
  if (forReps && !/going for|aiming for|trying for/.test(text.slice(Math.max(0, forReps.index - 8), forReps.index + forReps[0].length))) {
    weight ??= Number(forReps[1]);
    reps ??= Number(forReps[2]);
  }
  // bodyweight moves: "pull ups for 8"
  const bodyweight = text.match(/(?<!going |aiming |trying )\bfor (\d+)\b/);
  if (reps == null && bodyweight) reps = Number(bodyweight[1]);

  let name = ex?.name;
  if (!name) {
    const before = text.split(/\d/)[0].replace(/\b(the|a|on|at|with|i|did)\b/g, " ").trim();
    name = before ? titleCase(before) : "Exercise";
  }

  const unit = unitMatch && /lb|pound/.test(unitMatch[2]) ? "lb" : "kg";
  const eq = equipment ? equipment[1].replace(/s$/, "").replace(/^bar$/, "barbell") : null;

  return {
    exercise: name,
    known: Boolean(ex),
    group: ex?.group ?? "other",
    icon: ex?.icon ?? "dumbbell",
    bodyweight: Boolean(ex?.bodyweight),
    equipment: eq,
    weight,
    unit,
    target: target ? Number(target[1]) : null,
    reps,
    raw,
  };
}

// ---------- storage ----------

function loadDiary() {
  try {
    return JSON.parse(localStorage.getItem(DIARY_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveDiary(entries) {
  try {
    localStorage.setItem(DIARY_KEY, JSON.stringify(entries));
  } catch {
    // private mode or storage full: keep the in-memory diary for this visit
  }
}

let diary = loadDiary();

function addToDiary(text) {
  const entry = { ...parseSet(text, diary.at(-1)), id: crypto.randomUUID?.() ?? String(Date.now()), ts: Date.now() };
  diary.push(entry);
  saveDiary(diary);
  renderDiary();
  return entry;
}

// "add 20 kg", "actually got 10", "that was dumbbells": changes to the last entry, not a new set.
const AMEND = /^(add|added|plus|also|actually|update|change|correction|make (it|that)|it was|that was|that's|weight (was|is)?)\b/;

function isAmendment(text) {
  return AMEND.test(normalise(text));
}

// Merges the fields mentioned in `text` into the latest entry. Returns it, or null if there's nothing to change.
function amendLast(text) {
  const last = diary.at(-1);
  if (!last) return null;
  const norm = normalise(text).replace(AMEND, "").trim();
  const f = parseFields(norm, text);
  const changes = {};
  if (f.weight != null) Object.assign(changes, { weight: f.weight, unit: f.unit });
  if (f.reps != null) changes.reps = f.reps;
  if (f.target != null) changes.target = f.target;
  if (f.equipment) changes.equipment = f.equipment;
  if (f.known) Object.assign(changes, { exercise: f.exercise, group: f.group, icon: f.icon, bodyweight: f.bodyweight });
  if (!Object.keys(changes).length) {
    const n = norm.match(/(\d+(?:\.\d+)?)/);
    if (n) changes.weight = Number(n[1]);
  }
  if (!Object.keys(changes).length) return null;
  Object.assign(last, changes);
  saveDiary(diary);
  renderDiary();
  return last;
}

function describe(e) {
  const parts = [];
  if (e.weight != null) parts.push(`${e.weight} ${e.unit}`);
  if (e.reps != null && e.target != null) parts.push(`${e.reps} / ${e.target} reps`);
  else if (e.reps != null) parts.push(`${e.reps} reps`);
  else if (e.target != null) parts.push(`going for ${e.target}`);
  if (e.equipment) parts.push(e.equipment);
  return parts.join(" · ") || e.raw;
}

// ---------- rendering ----------

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ts) === dayKey(Date.now())) return "Today";
  if (dayKey(ts) === dayKey(yesterday)) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "long" });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name, group) {
  const span = el("span", `ico ${group}`);
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.dumbbell}</svg>`;
  return span;
}

function renderDiary() {
  const root = document.getElementById("diary");
  root.replaceChildren();
  if (!diary.length) {
    root.append(el("p", "empty", "Your logged sets will appear here."));
    return;
  }

  const days = new Map();
  for (const e of [...diary].reverse()) {
    const k = dayKey(e.ts);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }

  for (const entries of days.values()) {
    const day = el("div", "day");
    const head = el("div", "day-head");
    const name = el("span", "day-name", dayLabel(entries[0].ts));
    name.append(el("span", "day-date", new Date(entries[0].ts).toLocaleDateString(undefined, { day: "numeric", month: "short" })));
    head.append(name);

    const badges = el("span", "badges");
    const groups = [...new Set(entries.map((e) => e.group))].filter((g) => g !== "other");
    for (const g of (groups.length ? groups : ["other"])) badges.append(el("span", `badge ${g}`, GROUP_LABEL[g]));
    head.append(badges);

    const list = el("ul", "entries");
    for (const e of entries) {
      const li = el("li", "entry");
      li.dataset.id = e.id;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `Edit ${e.exercise}, ${describe(e)}`);
      const body = el("div", "entry-body");
      body.append(el("div", "ex", e.exercise), el("div", "meta", describe(e)));
      const time = el("time", null, new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      const chev = el("span", "chev");
      chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
      li.append(icon(e.icon, e.group), body, time, chev);
      list.append(li);
    }

    day.append(head, list);
    root.append(day);
  }
}

// ---------- editing and deleting ----------

let editingId = null;
let lastDeleted = null; // { entry, index } for Undo
let toastTimer = null;

const findEntry = (id) => diary.find((e) => e.id === id);
const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
const field = (id) => document.getElementById(id);

function updateEntry(id, changes) {
  const entry = findEntry(id);
  if (!entry) return null;
  Object.assign(entry, changes);
  saveDiary(diary);
  renderDiary();
  return entry;
}

function deleteEntry(id) {
  const index = diary.findIndex((e) => e.id === id);
  if (index < 0) return null;
  const [entry] = diary.splice(index, 1);
  lastDeleted = { entry, index };
  saveDiary(diary);
  renderDiary();
  return entry;
}

function undoDelete() {
  if (!lastDeleted) return null;
  const { entry, index } = lastDeleted;
  diary.splice(Math.min(index, diary.length), 0, entry);
  lastDeleted = null;
  saveDiary(diary);
  renderDiary();
  return entry;
}

function openEditor(id) {
  const e = findEntry(id);
  if (!e) return;
  editingId = id;
  field("fExercise").value = e.exercise;
  field("fWeight").value = e.weight ?? "";
  field("fUnit").value = e.unit ?? "kg";
  field("fReps").value = e.reps ?? "";
  field("fTarget").value = e.target ?? "";
  field("fEquipment").value = e.equipment ?? "";
  field("editor").showModal();
}

function saveEditor() {
  const current = findEntry(editingId);
  if (!current) return null;
  const name = field("fExercise").value.trim() || current.exercise;
  const changes = {
    weight: numOrNull(field("fWeight").value),
    unit: field("fUnit").value,
    reps: numOrNull(field("fReps").value),
    target: numOrNull(field("fTarget").value),
    equipment: field("fEquipment").value || null,
  };
  if (name !== current.exercise) {
    // a renamed exercise picks up its group and icon, if we know it
    const f = parseFields(normalise(name), name);
    Object.assign(changes, f.known
      ? { exercise: f.exercise, group: f.group, icon: f.icon, bodyweight: f.bodyweight }
      : { exercise: titleCase(name), group: "other", icon: "dumbbell", bodyweight: false });
  }
  return updateEntry(editingId, changes);
}

function showToast(text) {
  field("toastText").textContent = text;
  field("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  field("toast").hidden = true;
  lastDeleted = null;
}

field("exerciseNames").append(...EXERCISES.map((e) => Object.assign(document.createElement("option"), { value: e.name })));

field("diary").addEventListener("click", (ev) => {
  const row = ev.target.closest(".entry");
  if (row) openEditor(row.dataset.id);
});
field("diary").addEventListener("keydown", (ev) => {
  const row = ev.target.closest(".entry");
  if (row && ev.key === "Enter") openEditor(row.dataset.id);
});
field("editForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  saveEditor();
  field("editor").close();
});
field("editCancel").addEventListener("click", () => field("editor").close());
field("editor").addEventListener("click", (ev) => {
  if (ev.target === field("editor")) field("editor").close(); // tap outside the sheet
});
field("editDelete").addEventListener("click", () => {
  const entry = deleteEntry(editingId);
  field("editor").close();
  if (entry) showToast(`Deleted ${entry.exercise}`);
});
field("toastUndo").addEventListener("click", () => {
  undoDelete();
  clearTimeout(toastTimer);
  field("toast").hidden = true;
});

renderDiary();
