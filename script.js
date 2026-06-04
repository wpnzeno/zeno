const DB_NAME = "PrivateArchiveDB";
const DB_VERSION = 6;  // version upgrade for downloads/rating
const STORE_NAME = "posts";
const STORED_PASSWORD_KEY = "archive_admin_pass";
const DEFAULT_PASSWORD = "admin123";

let dbInstance = null;
let currentAdminLoggedIn = false; 

// helpers
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
}
function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024, sizes = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return parseFloat((bytes / Math.pow(k,i)).toFixed(1)) + " " + sizes[i];
}
function initPassword() {
  if (!localStorage.getItem(STORED_PASSWORD_KEY))
    localStorage.setItem(STORED_PASSWORD_KEY, DEFAULT_PASSWORD);
}

// IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance && dbInstance.name === DB_NAME) return resolve(dbInstance);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { dbInstance = request.result; resolve(dbInstance); };
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
      } else {
        // migrate existing store to add downloads/rating if needed
        const store = e.target.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains("downloads")) {
          // no need to create index, just ensure fields exist when reading/writing
        }
      }
    };
  });
}

async function getAllPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const index = tx.objectStore(STORE_NAME).index("createdAt");
    const req = index.openCursor(null, "prev");
    const results = [];
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        let post = c.value;
        // ensure new fields for old posts
        if (post.downloads === undefined) post.downloads = 0;
        if (post.rating === undefined) post.rating = 0;
        results.push(post);
        c.continue();
      } else resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

async function addPost(postData) {
  const db = await openDB();
  // add default metrics
  postData.downloads = 0;
  postData.rating = 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).add(postData);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updatePost(id, updatedData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const old = getReq.result;
      if (!old) reject("Post not found");
      const merged = { ...old, ...updatedData, id: old.id };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function deletePostById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function incrementDownloads(id) {
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === id);
  if (post) {
    const newDownloads = (post.downloads || 0) + 1;
    await updatePost(id, { downloads: newDownloads });
  }
}

// update stats
async function updateStats() {
  const posts = await getAllPosts();
  document.getElementById("statPosts").innerText = posts.length;
  document.getElementById("statFiles").innerText = posts.filter(p => p.type === "file").length;
  document.getElementById("statLinks").innerText = posts.filter(p => p.type === "link").length;
}

// PUBLIC FEED (grid cards)
async function renderPublicFeed() {
  const container = document.getElementById("publicPostsContainer");
  if (!container) return;
  try {
    const posts = await getAllPosts();
    await updateStats();
    if (!posts.length) { container.innerHTML = `<div class="loading-state"><i class="fas fa-inbox"></i> nothing posted yet</div>`; return; }
    let html = '';
    for (const post of posts) {
      const date = new Date(post.createdAt).toLocaleDateString();
      if (post.type === "link") {
        html += `<div class="post-card"><div class="post-title"><i class="fas fa-link"></i> ${escapeHtml(post.title)}</div>${post.description ? `<div class="post-description">${escapeHtml(post.description)}</div>` : ''}<div class="post-meta"><span><i class="fas fa-download"></i> ${post.downloads || 0}</span><a href="${escapeHtml(post.url)}" target="_blank" class="btn-icon" data-id="${post.id}" onclick="incrementAndOpen(event, ${post.id}, '${escapeHtml(post.url)}')"><i class="fas fa-external-link-alt"></i> open</a></div></div>`;
      } else {
        const file = post.fileData;
        const isImage = file?.type?.startsWith("image/");
        html += `<div class="post-card"><div class="post-title"><i class="fas fa-file-alt"></i> ${escapeHtml(post.title)}</div>${post.description ? `<div class="post-description">${escapeHtml(post.description)}</div>` : ''}<div class="post-meta"><span><i class="fas fa-download"></i> ${post.downloads || 0}</span><button class="btn-icon download-file" data-id="${post.id}"><i class="fas fa-download"></i> download</button></div>${isImage ? `<img id="preview-${post.id}" class="preview-img" style="max-height:100px; margin-top:0.5rem; border-radius:0.5rem;">` : ''}</div>`;
      }
    }
    container.innerHTML = html;
    // attach download events
    for (const post of posts) {
      if (post.type === "file" && post.fileData?.blob) {
        const btn = container.querySelector(`.download-file[data-id="${post.id}"]`);
        btn?.addEventListener("click", async () => {
          await incrementDownloads(post.id);
          downloadFileFromPost(post);
          renderPublicFeed(); // refresh counts
        });
        if (post.fileData.type?.startsWith("image/")) {
          const img = document.getElementById(`preview-${post.id}`);
          if (img && post.fileData.blob) {
            const url = URL.createObjectURL(post.fileData.blob);
            img.src = url;
            img.onload = () => URL.revokeObjectURL(url);
          }
        }
      }
    }
    // for links: we need global increment function
    window.incrementAndOpen = async (event, id, url) => {
      event.preventDefault();
      await incrementDownloads(id);
      window.open(url, '_blank');
      renderPublicFeed();
    };
  } catch (err) { container.innerHTML = `<div class="loading-state">⚠️ error</div>`; }
}

function downloadFileFromPost(post) {
  if (!post.fileData?.blob) return;
  const url = URL.createObjectURL(post.fileData.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = post.fileData.name || "download";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ADMIN ZONE (with Downloads & Rating, Edit/Delete)
async function renderAdminZone() {
  const container = document.getElementById("adminContentArea");
  if (!container) return;
  if (!currentAdminLoggedIn) {
    container.innerHTML = `<div style="max-width:420px; margin:2rem auto; text-align:center"><i class="fas fa-fingerprint" style="font-size:2.5rem; color:#00e0ff"></i><h3>admin authentication</h3><p style="font-size:0.8rem">only the owner can manage tools</p><div style="background:rgba(0,0,0,0.5); padding:1.5rem; border-radius:1.5rem"><input type="password" id="adminPassInput" placeholder="master password" style="width:100%; margin-bottom:1rem"><button id="adminLoginBtn" class="btn-primary" style="width:100%"><i class="fas fa-unlock-alt"></i> unlock</button><div style="font-size:0.7rem; margin-top:0.75rem">default: admin123</div></div></div>`;
    document.getElementById("adminLoginBtn")?.addEventListener("click", () => {
      if (document.getElementById("adminPassInput").value.trim() === localStorage.getItem(STORED_PASSWORD_KEY)) {
        currentAdminLoggedIn = true;
        renderAdminZone();
        renderPublicFeed();
      } else alert("❌ wrong password");
    });
    return;
  }
  const posts = await getAllPosts();
  container.innerHTML = `
    <div>
      <div style="display:flex; justify-content:space-between; flex-wrap:wrap; margin-bottom:1.5rem">
        <h3><i class="fas fa-crown"></i> admin controls</h3>
        <div><button id="changePwdBtn" class="btn-icon"><i class="fas fa-key"></i> change password</button> <button id="logoutAdminBtn" class="btn-icon" style="border-color:#ff4d6d"><i class="fas fa-sign-out-alt"></i> logout</button></div>
      </div>
      <div class="admin-form"><h4><i class="fas fa-link"></i> add new link</h4><input id="linkTitle" placeholder="Title *"><input id="linkUrl" placeholder="URL *"><textarea id="linkDesc" rows="2" placeholder="Description"></textarea><button id="submitLinkBtn" class="btn-primary">publish link</button></div>
      <div class="admin-form"><h4><i class="fas fa-file-upload"></i> upload file</h4><input id="fileTitle" placeholder="Title *"><textarea id="fileDesc" rows="2" placeholder="Description"></textarea><input type="file" id="singleFileInput"><button id="submitFileBtn" class="btn-primary">upload file</button></div>
      <div class="admin-form"><h4><i class="fas fa-layer-group"></i> multiple files</h4><input id="multiTitlePrefix" placeholder="Title prefix"><textarea id="multiDesc" rows="2" placeholder="Common description"></textarea><input type="file" id="multiFileInput" multiple><button id="submitMultiBtn" class="btn-primary">upload all</button></div>
      <h3 style="margin: 2rem 0 1rem">manage tools & content</h3>
      <div id="adminPostsList"></div>
    </div>`;
  await renderAdminPostsList(posts);
  document.getElementById("submitLinkBtn")?.addEventListener("click", handleAddLink);
  document.getElementById("submitFileBtn")?.addEventListener("click", handleAddFile);
  document.getElementById("submitMultiBtn")?.addEventListener("click", handleMultipleFiles);
  document.getElementById("logoutAdminBtn")?.addEventListener("click", () => { currentAdminLoggedIn = false; renderAdminZone(); renderPublicFeed(); });
  document.getElementById("changePwdBtn")?.addEventListener("click", handlePasswordChange);
}

async function renderAdminPostsList(posts) {
  const listDiv = document.getElementById("adminPostsList");
  if (!posts.length) { listDiv.innerHTML = `<div class="loading-state">no tools yet</div>`; return; }
  let html = '';
  for (const post of posts) {
    const downloads = post.downloads || 0;
    const rating = post.rating || 0;
    html += `
      <div class="admin-tool-card">
        <div class="tool-header">
          <div class="tool-title"><i class="fas ${post.type === 'link' ? 'fa-link' : 'fa-file-alt'}"></i> ${escapeHtml(post.title)}</div>
          <div class="tool-actions">
            <button class="btn-icon edit-post" data-id="${post.id}" data-type="${post.type}"><i class="fas fa-edit"></i> edit</button>
            <button class="btn-icon btn-danger delete-post" data-id="${post.id}"><i class="fas fa-trash-alt"></i> delete</button>
          </div>
        </div>
        ${post.description ? `<div class="tool-desc">${escapeHtml(post.description)}</div>` : ''}
        <div class="tool-stats">
          <span><i class="fas fa-download"></i> Downloads: ${downloads}</span>
          <span><i class="fas fa-star"></i> Rating: ${rating.toFixed(1)}</span>
        </div>
      </div>`;
  }
  listDiv.innerHTML = html;
  document.querySelectorAll(".delete-post").forEach(btn => btn.addEventListener("click", async () => {
    if (confirm("Delete this post permanently?")) {
      await deletePostById(Number(btn.dataset.id));
      renderAdminZone();
      renderPublicFeed();
    }
  }));
  document.querySelectorAll(".edit-post").forEach(btn => btn.addEventListener("click", () => editPostModal(Number(btn.dataset.id), btn.dataset.type)));
}

async function editPostModal(id, type) {
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return;
  const newTitle = prompt("Edit title:", post.title);
  if (newTitle === null) return;
  const newDesc = prompt("Edit description:", post.description || "");
  let newDownloads = prompt("Downloads count:", post.downloads || 0);
  if (newDownloads === null) return;
  newDownloads = parseInt(newDownloads) || 0;
  let newRating = prompt("Rating (0-5, e.g., 4.7):", post.rating || 0);
  if (newRating === null) return;
  newRating = parseFloat(newRating) || 0;
  if (newRating < 0) newRating = 0;
  if (newRating > 5) newRating = 5;
  let updateObj = { title: newTitle.trim(), description: newDesc.trim(), downloads: newDownloads, rating: newRating };
  if (type === "link") {
    const newUrl = prompt("Edit URL:", post.url);
    if (!newUrl?.startsWith("http")) return alert("URL must start with http");
    updateObj.url = newUrl.trim();
  }
  await updatePost(id, updateObj);
  renderAdminZone();
  renderPublicFeed();
}

// handlers for adding posts
async function handleAddLink() {
  const title = document.getElementById("linkTitle")?.value.trim();
  const url = document.getElementById("linkUrl")?.value.trim();
  const desc = document.getElementById("linkDesc")?.value.trim();
  if (!title || !url) return alert("Title and URL required");
  if (!url.startsWith("http")) return alert("Invalid URL");
  await addPost({ type: "link", title, description: desc || "", url, createdAt: Date.now() });
  document.getElementById("linkTitle").value = "";
  document.getElementById("linkUrl").value = "";
  document.getElementById("linkDesc").value = "";
  renderAdminZone();
  renderPublicFeed();
}

async function handleAddFile() {
  const title = document.getElementById("fileTitle")?.value.trim();
  const desc = document.getElementById("fileDesc")?.value.trim();
  const file = document.getElementById("singleFileInput").files[0];
  if (!title || !file) return alert("Title and file required");
  const fileData = { name: file.name, size: file.size, type: file.type, blob: file };
  await addPost({ type: "file", title, description: desc || "", fileData, createdAt: Date.now() });
  document.getElementById("fileTitle").value = "";
  document.getElementById("fileDesc").value = "";
  document.getElementById("singleFileInput").value = "";
  renderAdminZone();
  renderPublicFeed();
}

async function handleMultipleFiles() {
  const prefix = document.getElementById("multiTitlePrefix")?.value.trim();
  const commonDesc = document.getElementById("multiDesc")?.value.trim() || "";
  const files = Array.from(document.getElementById("multiFileInput").files);
  if (!files.length) return alert("Select at least one file");
  for (const file of files) {
    let title = prefix ? `${prefix} - ${file.name}` : file.name;
    if (title.length > 80) title = title.slice(0,77)+"...";
    const fileData = { name: file.name, size: file.size, type: file.type, blob: file };
    await addPost({ type: "file", title, description: commonDesc, fileData, createdAt: Date.now() });
  }
  document.getElementById("multiTitlePrefix").value = "";
  document.getElementById("multiDesc").value = "";
  document.getElementById("multiFileInput").value = "";
  alert(`✅ ${files.length} file(s) posted`);
  renderAdminZone();
  renderPublicFeed();
}

async function handlePasswordChange() {
  const old = prompt("Current password:");
  if (old !== localStorage.getItem(STORED_PASSWORD_KEY)) return alert("Wrong current password");
  const newPass = prompt("New password (min 4 chars):");
  if (!newPass || newPass.length < 4) return alert("At least 4 characters");
  if (newPass !== prompt("Confirm new password:")) return alert("Passwords do not match");
  localStorage.setItem(STORED_PASSWORD_KEY, newPass);
  alert("Password changed!");
}

function initTabs() {
  const pubPanel = document.getElementById("publicPanel"), adminPanel = document.getElementById("adminPanel");
  const pubBtn = document.getElementById("tabPublicBtn"), adminBtn = document.getElementById("tabAdminBtn");
  function setActive(tab) {
    pubBtn.classList.toggle("active", tab === "public");
    adminBtn.classList.toggle("active", tab === "admin");
    pubPanel.classList.toggle("hidden", tab !== "public");
    adminPanel.classList.toggle("hidden", tab !== "admin");
    if (tab === "admin") renderAdminZone();
  }
  pubBtn.onclick = () => setActive("public");
  adminBtn.onclick = () => setActive("admin");
  setActive("public");
}

(async () => {
  initPassword();
  await openDB();
  await renderPublicFeed();
  initTabs();
  renderAdminZone();
})();
