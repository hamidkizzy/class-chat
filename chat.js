/* ============================================================
   Screen management
   ============================================================ */
const screens = {
  loading: document.getElementById("screenLoading"),
  noCode: document.getElementById("screenNoCode"),
  classNotFound: document.getElementById("screenClassNotFound"),
  joinForm: document.getElementById("screenJoinForm"),
  waiting: document.getElementById("screenWaiting"),
  rejected: document.getElementById("screenRejected"),
  chat: document.getElementById("chatApp"),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

/* ============================================================
   Anonymous pseudonym tag (for display only, derived from the
   real auth user id — never reveals identity to other students)
   ============================================================ */
const ADJECTIVES = ["Blue", "Coral", "Amber", "Violet", "Silver", "Golden", "Mint", "Crimson", "Indigo", "Rose", "Teal", "Copper"];
const ANIMALS = ["Fox", "Owl", "Wolf", "Hawk", "Panda", "Otter", "Falcon", "Lynx", "Heron", "Raven", "Tiger", "Dolphin"];
const TAG_COLORS = ["#8B7CF6", "#22D3B6", "#FF7CA3", "#FFB454", "#4EA8FF", "#B18CFF", "#5FE0C7", "#FF8A65"];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function tagFor(id) {
  const h = hashString(id);
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length];
  const color = TAG_COLORS[h % TAG_COLORS.length];
  return { label: `${adjective} ${animal}`, color };
}

/* ============================================================
   State
   ============================================================ */
let session = null;
let currentClass = null;
let myTag = null;
const MAX_LEN = 500;
let isNearBottom = true;
let unseenCount = 0;
const rowsById = new Map();

/* ============================================================
   DOM refs (chat)
   ============================================================ */
const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("emptyState");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const charCountEl = document.getElementById("charCount");
const jumpBtn = document.getElementById("jumpToLatest");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const onlineCountEl = document.getElementById("onlineCount");
const chatClassNameEl = document.getElementById("chatClassName");

/* ============================================================
   Init flow
   ============================================================ */
(async function init() {
  const params = new URLSearchParams(location.search);
  const joinCode = params.get("class");

  if (!joinCode) {
    showScreen("noCode");
    return;
  }

  session = await ensureSession();
  if (!session) return; // ensureSession already shows an error screen

  currentClass = await findClass(joinCode);
  if (!currentClass) {
    showScreen("classNotFound");
    return;
  }

  myTag = tagFor(session.user.id);

  const membership = await getMembership(currentClass.id, session.user.id);

  if (!membership) {
    showJoinForm();
  } else if (membership.status === "pending") {
    showWaiting();
    listenForApprovalChange();
  } else if (membership.status === "rejected") {
    showScreen("rejected");
  } else if (membership.status === "approved") {
    enterChat();
  }
})();

async function ensureSession() {
  const { data: existing } = await sb.auth.getSession();
  if (existing.session) return existing.session;

  const { data, error } = await sb.auth.signInAnonymously();
  if (error) {
    console.error("Anonymous sign-in failed:", error);
    screens.loading.querySelector("p").textContent =
      "Couldn't start a session. Please refresh the page.";
    return null;
  }
  return data.session;
}

async function findClass(code) {
  const { data, error } = await sb
    .from("classes")
    .select("*")
    .eq("join_code", code)
    .maybeSingle();

  if (error) console.error("Class lookup failed:", error);
  return data;
}

async function getMembership(classId, userId) {
  const { data, error } = await sb
    .from("members")
    .select("*")
    .eq("class_id", classId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) console.error("Membership lookup failed:", error);
  return data;
}

/* ============================================================
   Join form
   ============================================================ */
function showJoinForm() {
  document.getElementById("joinClassName").textContent = currentClass.name;
  showScreen("joinForm");

  const nameInput = document.getElementById("joinName");
  const emailInput = document.getElementById("joinEmail");
  const submitBtn = document.getElementById("joinSubmitBtn");
  const errorEl = document.getElementById("joinError");

  submitBtn.addEventListener("click", async () => {
    const display_name = nameInput.value.trim();
    const email = emailInput.value.trim();
    errorEl.textContent = "";

    if (!display_name || !email) {
      errorEl.textContent = "Please fill in both your name and email.";
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = "That doesn't look like a valid email.";
      return;
    }

    submitBtn.disabled = true;
    const { error } = await sb.from("members").insert({
      user_id: session.user.id,
      class_id: currentClass.id,
      display_name,
      email,
    });

    if (error) {
      console.error("Join request failed:", error);
      errorEl.textContent = "Something went wrong. Please try again.";
      submitBtn.disabled = false;
      return;
    }

    showWaiting();
    listenForApprovalChange();
  });
}

/* ============================================================
   Waiting screen — listens live for the admin's decision
   ============================================================ */
function showWaiting() {
  document.getElementById("waitingClassName").textContent = currentClass.name;
  showScreen("waiting");
}

function listenForApprovalChange() {
  sb.channel(`membership:${session.user.id}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "members",
        filter: `user_id=eq.${session.user.id}`,
      },
      (payload) => {
        const status = payload.new.status;
        if (status === "approved") {
          enterChat();
        } else if (status === "rejected") {
          showScreen("rejected");
        }
      }
    )
    .subscribe();
}

/* ============================================================
   Chat
   ============================================================ */
function enterChat() {
  chatClassNameEl.textContent = currentClass.name;
  showScreen("chat");
  loadHistory().then(() => {
    subscribeRealtime();
    subscribePresence();
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessage(msg, { animate = true } = {}) {
  emptyStateEl.classList.add("hidden");

  const mine = msg.user_id === session.user.id;
  const tag = mine ? myTag : tagFor(msg.user_id);

  const row = document.createElement("div");
  row.className = `msg-row ${mine ? "mine" : "theirs"}`;
  if (!animate) row.style.animation = "none";

  if (!mine) {
    const tagEl = document.createElement("div");
    tagEl.className = "msg-tag";
    tagEl.style.color = tag.color;
    tagEl.textContent = tag.label;
    row.appendChild(tagEl);
  }

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = msg.content;
  wrap.appendChild(bubble);

  if (mine) {
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.setAttribute("aria-label", "Delete message");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => deleteMessage(msg.id));
    wrap.appendChild(delBtn);
  }

  row.appendChild(wrap);

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = formatTime(msg.created_at);
  row.appendChild(time);

  messagesEl.appendChild(row);
  if (msg.id != null) rowsById.set(msg.id, row);
  return row;
}

function removeMessageRow(id) {
  const row = rowsById.get(id);
  if (!row) return;
  row.classList.add("removing");
  setTimeout(() => row.remove(), 200);
  rowsById.delete(id);
}

async function deleteMessage(id) {
  const { error } = await sb.from("messages").delete().eq("id", id);
  if (error) {
    console.error("Delete failed:", error);
    return;
  }
  removeMessageRow(id);
}

function scrollToBottom(smooth = true) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  unseenCount = 0;
  jumpBtn.classList.add("hidden");
}

function checkNearBottom() {
  const threshold = 80;
  isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  if (isNearBottom) {
    unseenCount = 0;
    jumpBtn.classList.add("hidden");
  }
}

messagesEl.addEventListener("scroll", checkNearBottom);
jumpBtn.addEventListener("click", () => scrollToBottom(true));

async function loadHistory() {
  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("class_id", currentClass.id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("Failed to load messages:", error);
    setStatus("error", "couldn't load messages");
    return;
  }

  data.forEach((msg) => renderMessage(msg, { animate: false }));
  scrollToBottom(false);
}

function setStatus(state, label) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = label;
}

function subscribeRealtime() {
  setStatus("connecting", "connecting…");

  sb.channel(`class-messages:${currentClass.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `class_id=eq.${currentClass.id}` },
      (payload) => {
        const msg = payload.new;
        const wasNearBottom = isNearBottom;
        renderMessage(msg);

        if (msg.user_id !== session.user.id && document.hidden) {
          playPing();
        }

        if (wasNearBottom) {
          scrollToBottom(true);
        } else {
          unseenCount += 1;
          jumpBtn.textContent = `↓ ${unseenCount} new message${unseenCount > 1 ? "s" : ""}`;
          jumpBtn.classList.remove("hidden");
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "messages", filter: `class_id=eq.${currentClass.id}` },
      (payload) => removeMessageRow(payload.old.id)
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setStatus("connected", "live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setStatus("error", "connection issue");
      else if (status === "CLOSED") setStatus("connecting", "reconnecting…");
    });
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content) return;

  sendBtn.disabled = true;

  const { error } = await sb.from("messages").insert({
    class_id: currentClass.id,
    user_id: session.user.id,
    content,
  });

  if (error) {
    console.error("Send failed:", error);
    setStatus("error", "message failed to send");
    sendBtn.disabled = false;
    return;
  }

  inputEl.value = "";
  autoResize();
  updateCharCount();
  sendBtn.disabled = false;
  inputEl.focus();
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

function updateCharCount() {
  const len = inputEl.value.length;
  charCountEl.textContent = `${len}/${MAX_LEN}`;
  charCountEl.classList.toggle("limit", len >= MAX_LEN - 20);
}

inputEl.addEventListener("input", () => {
  autoResize();
  updateCharCount();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);
updateCharCount();

/* ============================================================
   Online presence counter
   ============================================================ */
function subscribePresence() {
  const presenceChannel = sb.channel(`presence:${currentClass.id}`, {
    config: { presence: { key: session.user.id } },
  });

  presenceChannel
    .on("presence", { event: "sync" }, () => {
      const state = presenceChannel.presenceState();
      const count = Object.keys(state).length;
      onlineCountEl.textContent = `${count} online`;
      onlineCountEl.classList.remove("hidden");
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await presenceChannel.track({ online_at: new Date().toISOString() });
      }
    });
}

/* ============================================================
   Notification sound
   ============================================================ */
let audioCtx = null;

function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } else if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

["click", "keydown", "touchstart"].forEach((evt) =>
  window.addEventListener(evt, unlockAudio, { once: true })
);

function playPing() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.32);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.32);
}
