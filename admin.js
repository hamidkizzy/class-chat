const screenLogin = document.getElementById("screenLogin");
const screenDashboard = document.getElementById("screenDashboard");
const classListEl = document.getElementById("classList");

/* ============================================================
   Auth
   ============================================================ */
(async function init() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const admin = await checkIsAdmin();
    if (admin) {
      enterDashboard();
      return;
    }
    await sb.auth.signOut();
  }
  screenLogin.classList.remove("hidden");
})();

async function checkIsAdmin() {
  const { data, error } = await sb.rpc("is_admin");
  if (error) {
    console.error("Admin check failed:", error);
    return false;
  }
  return data === true;
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  const btn = document.getElementById("loginBtn");
  errorEl.textContent = "";

  if (!email || !password) {
    errorEl.textContent = "Enter both email and password.";
    return;
  }

  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    errorEl.textContent = "Invalid email or password.";
    btn.disabled = false;
    return;
  }

  const admin = await checkIsAdmin();
  if (!admin) {
    errorEl.textContent = "This account isn't an admin.";
    await sb.auth.signOut();
    btn.disabled = false;
    return;
  }

  enterDashboard();
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

function enterDashboard() {
  screenLogin.classList.add("hidden");
  screenDashboard.classList.remove("hidden");
  loadClasses();
}

/* ============================================================
   Class creation
   ============================================================ */
function generateJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 7; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

document.getElementById("createClassBtn").addEventListener("click", async () => {
  const nameInput = document.getElementById("newClassName");
  const errorEl = document.getElementById("createClassError");
  const name = nameInput.value.trim();
  errorEl.textContent = "";

  if (!name) {
    errorEl.textContent = "Give the class a name first.";
    return;
  }

  const join_code = generateJoinCode();
  const { error } = await sb.from("classes").insert({ name, join_code });

  if (error) {
    console.error("Create class failed:", error);
    errorEl.textContent = "Couldn't create the class. Try again.";
    return;
  }

  nameInput.value = "";
  loadClasses();
});

/* ============================================================
   Class list + details
   ============================================================ */
async function loadClasses() {
  const { data: classes, error } = await sb
    .from("classes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load classes:", error);
    return;
  }

  classListEl.innerHTML = "";

  if (!classes.length) {
    classListEl.innerHTML = `<div class="panel glass"><p class="empty-row">No classes yet — create one above.</p></div>`;
    return;
  }

  for (const cls of classes) {
    const card = await renderClassCard(cls);
    classListEl.appendChild(card);
  }
}

async function renderClassCard(cls) {
  const joinLink = `${location.origin}${location.pathname.replace("admin.html", "")}index.html?class=${cls.join_code}`;

  const { data: members, error: memberErr } = await sb
    .from("members")
    .select("*")
    .eq("class_id", cls.id)
    .order("created_at", { ascending: false });

  if (memberErr) console.error("Failed to load members:", memberErr);

  const allMembers = members || [];
  const pending = allMembers.filter((m) => m.status === "pending");
  const approved = allMembers.filter((m) => m.status === "approved");

  const { data: messages, error: msgErr } = await sb
    .from("messages")
    .select("*")
    .eq("class_id", cls.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (msgErr) console.error("Failed to load messages:", msgErr);

  const memberByUserId = new Map(allMembers.map((m) => [m.user_id, m]));

  const card = document.createElement("div");
  card.className = "class-card glass";

  card.innerHTML = `
    <div class="class-card-head">
      <div>
        <h3>${escapeHtml(cls.name)}</h3>
        <div class="meta">code: ${cls.join_code} · created ${new Date(cls.created_at).toLocaleDateString()}</div>
      </div>
    </div>
    <div class="share-row">
      <div class="share-link">${joinLink}</div>
      <button class="btn-secondary copy-link-btn">Copy link</button>
      <button class="qr-toggle">Show QR code</button>
    </div>
    <div class="qr-wrap hidden">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(joinLink)}" alt="QR code" width="180" height="180" />
    </div>

    <div class="section-label">Pending requests (${pending.length})</div>
    <div class="pending-list"></div>

    <div class="section-label">Approved members (${approved.length})</div>
    <div class="approved-list"></div>

    <div class="section-label">Recent messages (${(messages || []).length})</div>
    <div class="message-log"></div>
  `;

  // copy link
  card.querySelector(".copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(joinLink);
    const btn = card.querySelector(".copy-link-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1500);
  });

  // QR toggle
  card.querySelector(".qr-toggle").addEventListener("click", () => {
    card.querySelector(".qr-wrap").classList.toggle("hidden");
  });

  // pending list
  const pendingListEl = card.querySelector(".pending-list");
  if (!pending.length) {
    pendingListEl.innerHTML = `<div class="empty-row">No pending requests.</div>`;
  } else {
    pending.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML = `
        <div class="member-info">
          <div class="name">${escapeHtml(m.display_name)}</div>
          <div class="email">${escapeHtml(m.email)}</div>
        </div>
        <div class="member-actions">
          <button class="pill-btn approve">Approve</button>
          <button class="pill-btn reject">Reject</button>
        </div>
      `;
      row.querySelector(".approve").addEventListener("click", () =>
        updateMemberStatus(m.user_id, cls.id, "approved")
      );
      row.querySelector(".reject").addEventListener("click", () =>
        updateMemberStatus(m.user_id, cls.id, "rejected")
      );
      pendingListEl.appendChild(row);
    });
  }

  // approved list
  const approvedListEl = card.querySelector(".approved-list");
  if (!approved.length) {
    approvedListEl.innerHTML = `<div class="empty-row">No approved members yet.</div>`;
  } else {
    approved.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML = `
        <div class="member-info">
          <div class="name">${escapeHtml(m.display_name)}</div>
          <div class="email">${escapeHtml(m.email)}</div>
        </div>
        <span class="status-badge approved">approved</span>
      `;
      approvedListEl.appendChild(row);
    });
  }

  // message log
  const logEl = card.querySelector(".message-log");
  if (!messages || !messages.length) {
    logEl.innerHTML = `<div class="empty-row">No messages yet.</div>`;
  } else {
    messages.forEach((msg) => {
      const sender = memberByUserId.get(msg.user_id);
      const row = document.createElement("div");
      row.className = "msg-log-row";
      row.innerHTML = `
        <div class="msg-log-head">
          <span class="sender">${sender ? escapeHtml(sender.display_name) : "Unknown"} ${sender ? `· ${escapeHtml(sender.email)}` : ""}</span>
          <span>${new Date(msg.created_at).toLocaleString()}</span>
        </div>
        <div class="msg-log-body">${escapeHtml(msg.content)}</div>
      `;
      logEl.appendChild(row);
    });
  }

  return card;
}

async function updateMemberStatus(userId, classId, status) {
  const { error } = await sb
    .from("members")
    .update({ status })
    .eq("user_id", userId)
    .eq("class_id", classId);

  if (error) {
    console.error("Failed to update member status:", error);
    return;
  }
  loadClasses();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
