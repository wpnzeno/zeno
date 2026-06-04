const DB_NAME = "PrivateArchiveDB";
const DB_VERSION = 5;
const STORE_NAME = "posts";
const STORED_PASSWORD_KEY = "archive_admin_pass";
const DEFAULT_PASSWORD = "admin123";

let dbInstance = null;
let currentAdminLoggedIn = false;

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
    req.onsuccess = (e) => { const c = e.target.result; if(c) { results.push(c.value); c.continue(); } else resolve(results); };
    req.onerror = () => reject(req.error);
  });
}

async function addPost(postData) {
  const db = await openDB();
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

async function renderPublicFeed() {
  const container = document.getElementById("publicPostsContainer");
  if (!container) return;
  try {
    const posts = await getAllPosts();
    if (!posts.length) {
      container.innerHTML = `<div class="placeholder"><i class="fas fa-moon"></i> nothing posted yet · admin can add files & links</div>`;
      return;
    }
    let html = '';
    for (const post of posts) {
      const date = new Date(post.createdAt).toLocaleString();
      if (post.type === "link") {
        html += `<div class="post-item"><div class="post-header"><div class="post-title"><i class="fas fa-link" style="color:#5f8eff"></i> ${escapeHtml(post.title)}</div><div class="post-date">${date}</div></div>${post.description ? `<div class="post-desc">${escapeHtml(post.description)}</div>` : ''}<div class="post-action"><a href="${escapeHtml(post.url)}" target="_blank" class="btn-link"><i class="fas fa-external-link-alt"></i> open link</a></div></div>`;
      } else if (post.type === "file") {
        const file = post.fileData;
        const isImage = file?.type?.startsWith("image/");
        html += `<div class="post-item" data-file-id="${post.id}"><div class="post-header"><div class="post-title"><i class="fas fa-file-alt" style="color:#ffb347"></i> ${escapeHtml(post.title)}</div><div class="post-date">${date}</div></div>${post.description ? `<div class="post-desc">${escapeHtml(post.description)}</div>` : ''}<div class="post-action"><span class="file-meta"><i class="far fa-file"></i> ${escapeHtml(file?.name || "file")} · ${formatFileSize(file?.size || 0)}</span><button class="btn-download download-file" data-id="${post.id}"><i class="fas fa-download"></i> download</button></div>${isImage ? `<div style="margin-left:1.8rem; margin-top:0.75rem;"><img id="preview-${post.id}" class="preview-img" alt="preview"></div>` : ''}</div>`;
      }
    }
    container.innerHTML = html;
    for (const post of posts) {
      if (post.type === "file" && post.fileData?.blob) {
        const btn = document.querySelector(`.download-file[data-id="${post.id}"]`);
        btn?.addEventListener("click", () => downloadFileFromPost(post));
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
  } catch (err) { container.innerHTML = `<div class="placeholder" style="color:#ff9494">⚠️ error loading posts</div>`; }
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

async function renderAdminZone() {
  const container = document.getElementById("adminContentArea");
  if (!container) return;
  if (!currentAdminLoggedIn) {
    container.innerHTML = `<div class="login-box"><div style="text-align:center; margin-bottom:1rem"><i class="fas fa-fingerprint" style="font-size:2.5rem; color:#6d8eff"></i><h3>admin authentication</h3><p style="font-size:0.8rem">only the owner can post & manage</p></div><div style="background:rgba(0,0,0,0.5); padding:1.5rem; border-radius:1.5rem; backdrop-filter:blur(8px)"><input type="password" id="adminPassInput" placeholder="master password"><button id="adminLoginBtn" class="btn-primary" style="width:100%"><i class="fas fa-unlock-alt"></i> unlock archive</button><div style="font-size:0.7rem; text-align:center; margin-top:0.75rem">default: admin123</div></div></div>`;
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
  container.innerHTML = `<div class="admin-dashboard"><div style="display:flex; justify-content:space-between; flex-wrap:wrap; margin-bottom:1.5rem"><h2><i class="fas fa-crown" style="color:#ffcd4a"></i> admin dashboard</h2><div><button id="changePwdBtn" class="btn-outline"><i class="fas fa-key"></i> change password</button> <button id="logoutAdminBtn" class="btn-outline" style="border-color:#ff7575; color:#ffabab"><i class="fas fa-sign-out-alt"></i> logout</button></div></div><div class="admin-form"><h3><i class="fas fa-link"></i> post new link</h3><div class="form-group"><input id="linkTitle" placeholder="Title *"></div><div class="form-group"><input id="linkUrl" placeholder="URL *"></div><div class="form-group"><textarea id="linkDesc" rows="2" placeholder="Description (optional)"></textarea></div><button id="submitLinkBtn" class="btn-primary"><i class="fas fa-plus-circle"></i> publish link</button></div><div class="admin-form"><h3><i class="fas fa-file-upload"></i> upload single file</h3><div class="form-group"><input id="fileTitle" placeholder="Title *"></div><div class="form-group"><textarea id="fileDesc" rows="2" placeholder="Description"></textarea></div><div class="form-group"><input type="file" id="singleFileInput" class="file-input"></div><button id="submitFileBtn" class="btn-primary"><i class="fas fa-cloud-upload-alt"></i> upload file</button></div><div class="admin-form" style="background:rgba(30, 60, 100, 0.5); border-left-color:#2dd4bf"><h3><i class="fas fa-layer-group"></i> upload multiple files</h3><div class="form-group"><input id="multiTitlePrefix" placeholder="Title prefix (optional)"></div><div class="form-group"><textarea id="multiDesc" rows="2" placeholder="Common description (shared)"></textarea></div><div class="form-group"><input type="file" id="multiFileInput" multiple class="file-input"></div><button id="submitMultiBtn" class="btn-primary" style="background:#2b6b6f"><i class="fas fa-upload"></i> upload all files</button></div><div><h3 style="margin-bottom:1rem"><i class="fas fa-archive"></i> manage posts (${posts.length})</h3><div id="adminPostsList"></div></div></div>`;
  await renderAdminPostsList(posts);
  document.getElementById("submitLinkBtn")?.addEventListener("click", handleAddLink);
  document.getElementById("submitFileBtn")?.addEventListener("click", handleAddFile);
  document.getElementById("submitMultiBtn")?.addEventListener("click", handleMultipleFiles);
  document.getElementById("logoutAdminBtn")?.addEventListener("click", () => { currentAdminLoggedIn = false; renderAdminZone(); renderPublicFeed(); });
  document.getElementById("changePwdBtn")?.addEventListener("click", handlePasswordChange);
}

async function renderAdminPostsList(posts) {
  const listDiv = document.getElementById("adminPostsList");
  if (!posts.length) { listDiv.innerHTML = `<div class="placeholder">no posts yet</div>`; return; }
  let html = '';
  for (const post of posts) {
    const date = new Date(post.createdAt).toLocaleString();
    if (post.type === "link") {
      html += `<div class="admin-post-item"><div class="admin-post-info"><i class="fas fa-link" style="color:#5f8eff"></i> <strong>${escapeHtml(post.title)}</strong> <span style="font-size:0.7rem">${date}</span></div><div><button class="btn-edit edit-post" data-id="${post.id}" data-type="link"><i class="fas fa-edit"></i> edit</button> <button class="btn-danger delete-post" data-id="${post.id}"><i class="fas fa-trash-alt"></i> delete</button></div></div>`;
    } else {
      html += `<div class="admin-post-item"><div class="admin-post-info"><i class="fas fa-file" style="color:#f5b042"></i> <strong>${escapeHtml(post.title)}</strong> (${escapeHtml(post.fileData?.name || 'file')}) <span style="font-size:0.7rem">${date}</span></div><div><button class="btn-edit edit-post" data-id="${post.id}" data-type="file"><i class="fas fa-edit"></i> edit</button> <button class="btn-danger delete-post" data-id="${post.id}"><i class="fas fa-trash-alt"></i> delete</button></div></div>`;
    }
  }
  listDiv.innerHTML = html;
  document.querySelectorAll(".delete-post").forEach(btn => btn.addEventListener("click", async (e) => {
    if (confirm("Permanently delete this post?")) {
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
  if (type === "link") {
    const newTitle = prompt("Edit title:", post.title);
    if (newTitle === null) return;
    const newDesc = prompt("Edit description:", post.description || "");
    const newUrl = prompt("Edit URL:", post.url);
    if (!newUrl?.startsWith("http")) return alert("URL must start with http");
    await updatePost(id, { title: newTitle.trim(), description: newDesc.trim(), url: newUrl.trim() });
  } else {
    const newTitle = prompt("Edit title:", post.title);
    if (newTitle === null) return;
    const newDesc = prompt("Edit description:", post.description || "");
    await updatePost(id, { title: newTitle.trim(), description: newDesc.trim() });
  }
  renderAdminZone();
  renderPublicFeed();
}

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
  alert("Password changed successfully!");
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
