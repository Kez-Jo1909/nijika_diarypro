import { activeCharacters, findCharacter } from "./characters.js";
import { dateContext, completeChat, parseJsonObject } from "./llm.js";
import { commit, load, newId, save } from "./store.js";

const ME = "me";

const ui = {
  kindFilter: "all",
  authorFilter: null,
  composeKind: "shuoshuo",
  pendingPosts: new Set(),
  friendBusy: false
};

const feedEl = document.querySelector("#feed");
const toastEl = document.querySelector("#toast");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function authorName(authorId, state) {
  if (authorId === ME) return state.profile.name || "我";
  return findCharacter(authorId)?.shortName || "好友";
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff >= 0 && diff < 60 * 1000) return "刚刚";
  if (diff >= 0 && diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const sameDay = date.toDateString() === now.toDateString();
  const hm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

function settingsOf(state) {
  return state.settings;
}

function recentLines(state, exceptId) {
  return state.posts
    .filter((post) => post.id !== exceptId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6)
    .map((post) => {
      const who = authorName(post.authorId, state);
      const title = post.title ? `《${post.title}》` : "";
      const body = post.content.replace(/\s+/g, " ").slice(0, 80);
      return `- ${who}的${post.kind === "diary" ? "日志" : "说说"}${title}：${body}`;
    })
    .join("\n");
}

function recordVisit(state, characterId, text) {
  state.visits = [
    { characterId, at: new Date().toISOString(), text },
    ...(state.visits || [])
  ].slice(0, 20);
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1|是)$/i.test(value.trim());
  return Boolean(value);
}

async function askCharacter(character, task, maxTokens) {
  const state = load();
  const settings = settingsOf(state);
  const text = await completeChat({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: 0.9,
    maxTokens,
    messages: [
      {
        role: "system",
        content: `${character.systemPrompt}\n\n只输出一个 JSON 对象，不要 markdown，不要解释。`
      },
      { role: "user", content: task }
    ]
  });
  return parseJsonObject(text);
}

function dateLine() {
  const ctx = dateContext();
  const extra = ctx.notes.length ? `\n${ctx.notes.join("；")}。` : "";
  return `现在是${ctx.month}月${ctx.day}日，${ctx.week}，${ctx.season}。${extra}`;
}

async function reactToPost(postId) {
  if (ui.pendingPosts.has(postId)) return;
  const state = load();
  const post = state.posts.find((item) => item.id === postId);
  if (!post) return;

  const visitors = activeCharacters().filter((character) => character.id !== post.authorId);
  if (!visitors.length) return;

  ui.pendingPosts.add(postId);
  render();

  try {
    for (const character of visitors) {
      const fresh = load();
      const current = fresh.posts.find((item) => item.id === postId);
      if (!current) continue;
      const owner = authorName(current.authorId, fresh);
      const kindLabel = current.kind === "diary" ? "日志" : "说说";
      const result = await askCharacter(
        character,
        `${dateLine()}
好友「${owner}」发了一条${kindLabel}。
${current.title ? `标题：${current.title}\n` : ""}正文：
${current.content}

空间里最近的动态，只用来避免复读，不要逐条点评：
${recentLines(fresh, current.id) || "（还没有别的动态）"}

按这个格式回复：{"like":true或false,"comment":"一句留言，不想说就空字符串"}`,
        280
      );

      const commentText = String(result.comment || "").trim().slice(0, 200);
      const liked = asBool(result.like);
      commit((draft) => {
        const target = draft.posts.find((item) => item.id === postId);
        if (!target) return;
        if (liked && !target.likes.includes(character.id)) target.likes.push(character.id);
        if (commentText) {
          target.comments.push({
            id: newId(),
            authorId: character.id,
            content: commentText,
            createdAt: new Date().toISOString()
          });
        }
        const action = commentText ? "留了言" : liked ? "点了赞" : "看了一眼";
        recordVisit(draft, character.id, `${action}：${owner}的${kindLabel}`);
      });
      if (!commentText && !liked) toast(`${character.shortName}看过了，这次没留言`);
    }
  } catch (err) {
    toast(err.message || "好友没能过来");
  } finally {
    ui.pendingPosts.delete(postId);
    render();
  }
}

async function friendPublish(character, kind) {
  if (ui.friendBusy) return;
  ui.friendBusy = true;
  render();
  toast(`${character.shortName}正在写……`);

  try {
    const state = load();
    const userName = state.profile.name || "好友";
    const schema = kind === "diary"
      ? '{"title":"日志标题","content":"正文"}'
      : '{"title":"","content":"说说正文"}';
    const result = await askCharacter(
      character,
      `${dateLine()}
你在自己好友「${userName}」的空间里发一条${kind === "diary" ? "日志" : "说说"}。
写你自己今天的生活，不要代替对方说话，也不要复述下面这些旧动态。

最近动态：
${recentLines(state) || "（空间刚开张）"}

按这个格式回复：${schema}`,
      kind === "diary" ? 900 : 320
    );

    const content = String(result.content || "").trim();
    const title = kind === "diary" ? String(result.title || "").trim().slice(0, 40) : "";
    if (content.length < 8) throw new Error(`${character.shortName}这次没写成`);
    if (kind === "diary" && !title) throw new Error("日志缺少标题");

    commit((draft) => {
      draft.posts.push({
        id: newId(),
        authorId: character.id,
        kind,
        title,
        content: content.slice(0, 4000),
        createdAt: new Date().toISOString(),
        likes: [],
        comments: []
      });
      recordVisit(draft, character.id, kind === "diary" ? "写了一篇日志" : "发了一条说说");
    });
    toast(`${character.shortName}发表了`);
  } catch (err) {
    toast(err.message || "没写出来");
  } finally {
    ui.friendBusy = false;
    render();
  }
}

function visiblePosts(state) {
  return state.posts
    .filter((post) => ui.kindFilter === "all" || post.kind === ui.kindFilter)
    .filter((post) => !ui.authorFilter || post.authorId === ui.authorFilter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function avatarHtml(authorId, state, variant) {
  const sizeClass = variant === "mini" ? "mini-avatar" : variant === "small" ? "avatar small" : "avatar";
  if (authorId === ME) {
    const letter = (state.profile.name || "我").slice(0, 1);
    return `<div class="${sizeClass}">${escapeHtml(letter)}</div>`;
  }
  const character = findCharacter(authorId);
  if (authorId === "nijika") {
    return `<div class="${sizeClass} nijika" aria-hidden="true"></div>`;
  }
  const color = character?.color || "#8eb8dc";
  const letter = (character?.shortName || "?").slice(0, 1);
  return `<div class="${sizeClass}" style="background:${escapeHtml(color)}">${escapeHtml(letter)}</div>`;
}

function renderPost(post, state) {
  const name = authorName(post.authorId, state);
  const nameClass = post.authorId === ME ? "who" : "who nijika";
  const kind = post.kind === "diary"
    ? '<span class="kind-tag diary">日志</span>'
    : '<span class="kind-tag">说说</span>';
  const title = post.kind === "diary" && post.title
    ? `<h3 class="post-title">${escapeHtml(post.title)}</h3>`
    : "";
  const liked = post.likes.includes(ME);
  const likeNames = post.likes.map((id) => authorName(id, state));
  const likeLine = likeNames.length
    ? `<div class="like-line">${escapeHtml(likeNames.join("、"))} 觉得很赞</div>`
    : "";
  const comments = post.comments.map((comment) => `
    <div class="comment">
      <b class="${comment.authorId === ME ? "" : "who nijika"}">${escapeHtml(authorName(comment.authorId, state))}</b>
      ：${escapeHtml(comment.content)}
      <span class="meta">${escapeHtml(formatTime(comment.createdAt))}</span>
    </div>
  `).join("");
  const commentBlock = comments ? `<div class="comments">${comments}</div>` : "";
  const pending = ui.pendingPosts.has(post.id)
    ? `<div class="pending">好友正在看这条……</div>`
    : "";
  const summon = activeCharacters()
    .filter((character) => character.id !== post.authorId)
    .map((character) => `
      <button class="text-btn" type="button" data-act="summon" data-id="${escapeHtml(post.id)}" ${ui.pendingPosts.has(post.id) ? "disabled" : ""}>
        叫${escapeHtml(character.shortName)}来看
      </button>
    `).join("");

  return `
    <article class="card post">
      <div class="post-top">
        ${avatarHtml(post.authorId, state, "small")}
        <div class="post-main">
          <div>
            <span class="${nameClass}">${escapeHtml(name)}</span>
            ${kind}
            <span class="when">${escapeHtml(formatTime(post.createdAt))}</span>
          </div>
          ${title}
          <div class="post-content">${escapeHtml(post.content)}</div>
          <div class="actions">
            <button class="text-btn ${liked ? "liked" : ""}" type="button" data-act="like" data-id="${escapeHtml(post.id)}">${liked ? "已赞" : "赞"}</button>
            ${summon}
            <button class="text-btn danger" type="button" data-act="delete" data-id="${escapeHtml(post.id)}">删除</button>
          </div>
          ${likeLine}
          ${commentBlock}
          ${pending}
          <form class="comment-box" data-post="${escapeHtml(post.id)}">
            <textarea maxlength="300" placeholder="说点什么……"></textarea>
            <div class="comment-bar">
              <span class="hint" style="margin:0">Enter 发送，Shift+Enter 换行</span>
              <button class="ghost" type="submit">评论</button>
            </div>
          </form>
        </div>
      </div>
    </article>
  `;
}

function render() {
  const state = load();
  const posts = visiblePosts(state);

  const nameInput = document.querySelector("#profile-name");
  const signInput = document.querySelector("#profile-sign");
  if (document.activeElement !== nameInput) nameInput.value = state.profile.name;
  if (document.activeElement !== signInput) signInput.value = state.profile.signature;
  document.querySelector("#my-avatar").textContent = (state.profile.name || "我").slice(0, 1);
  document.querySelector("#call-friend").checked = state.settings.autoReact;
  document.querySelector("#call-label").textContent =
    `发表后叫${activeCharacters().map((item) => item.shortName).join("、") || "好友"}来看`;

  const mine = state.posts.filter((post) => post.authorId === ME);
  document.querySelector("#stat-talk").textContent = String(mine.filter((post) => post.kind === "shuoshuo").length);
  document.querySelector("#stat-diary").textContent = String(mine.filter((post) => post.kind === "diary").length);
  document.querySelector("#stat-comment").textContent = String(
    mine.reduce((sum, post) => sum + post.comments.filter((comment) => comment.authorId !== ME).length, 0)
  );

  const friend = ui.authorFilter ? findCharacter(ui.authorFilter) : null;
  const kindName = { all: "全部动态", shuoshuo: "说说", diary: "日志" }[ui.kindFilter];
  document.querySelector("#feed-title").textContent = friend ? `${friend.shortName}的${kindName}` : kindName;

  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === ui.kindFilter);
  });

  feedEl.innerHTML = posts.length
    ? posts.map((post) => renderPost(post, state)).join("")
    : `<div class="card empty">这里还空着。写一条说说，或者让虹夏先开口。</div>`;

  document.querySelector("#friend-list").innerHTML = activeCharacters().map((character) => `
    <div class="friend">
      ${avatarHtml(character.id, state, "mini")}
      <div>
        <div class="friend-name">${escapeHtml(character.shortName)}<span class="online">在线</span></div>
        <p>${escapeHtml(character.signature)}</p>
        <div class="friend-actions">
          <button class="ghost" type="button" data-friend="${escapeHtml(character.id)}" data-act="shuoshuo" ${ui.friendBusy ? "disabled" : ""}>发说说</button>
          <button class="ghost" type="button" data-friend="${escapeHtml(character.id)}" data-act="diary" ${ui.friendBusy ? "disabled" : ""}>写日志</button>
          <button class="ghost" type="button" data-friend="${escapeHtml(character.id)}" data-act="filter">${ui.authorFilter === character.id ? "看全部" : "只看她"}</button>
        </div>
      </div>
    </div>
  `).join("");

  const visits = state.visits || [];
  document.querySelector("#visits").innerHTML = visits.length
    ? visits.slice(0, 8).map((visit) => {
      const who = findCharacter(visit.characterId)?.shortName || "好友";
      return `<div class="visit">${escapeHtml(who)} ${escapeHtml(visit.text)}<br><span>${escapeHtml(formatTime(visit.at))}</span></div>`;
    }).join("")
    : `<div class="visit"><span>还没有人来过。</span></div>`;

  const titleInput = document.querySelector("#diary-title");
  titleInput.hidden = ui.composeKind !== "diary";
  document.querySelector("#composer-text").placeholder = ui.composeKind === "diary"
    ? "今天发生了什么……"
    : "分享新鲜事……";
}

function publishPost(event) {
  event.preventDefault();
  const text = document.querySelector("#composer-text").value.trim();
  const title = document.querySelector("#diary-title").value.trim();
  if (!text) {
    toast("先写点内容");
    return;
  }
  if (ui.composeKind === "diary" && !title) {
    toast("日志要有个标题");
    return;
  }

  const callFriend = document.querySelector("#call-friend").checked;
  let postId = "";
  commit((state) => {
    postId = newId();
    state.posts.push({
      id: postId,
      authorId: ME,
      kind: ui.composeKind,
      title: ui.composeKind === "diary" ? title.slice(0, 40) : "",
      content: text,
      createdAt: new Date().toISOString(),
      likes: [],
      comments: []
    });
    state.settings.autoReact = callFriend;
  });

  document.querySelector("#composer-text").value = "";
  document.querySelector("#diary-title").value = "";
  render();
  if (callFriend) reactToPost(postId);
}

function onFeedClick(event) {
  const button = event.target.closest("button[data-act]");
  if (!button || !feedEl.contains(button)) return;
  const postId = button.dataset.id;
  if (button.dataset.act === "like") {
    commit((state) => {
      const post = state.posts.find((item) => item.id === postId);
      if (!post) return;
      if (post.likes.includes(ME)) post.likes = post.likes.filter((id) => id !== ME);
      else post.likes.push(ME);
    });
    render();
    return;
  }
  if (button.dataset.act === "delete") {
    const state = load();
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return;
    const label = post.kind === "diary" ? "这篇日志" : "这条说说";
    if (!window.confirm(`删除${label}？评论也会一起没掉。`)) return;
    commit((draft) => {
      draft.posts = draft.posts.filter((item) => item.id !== postId);
    });
    render();
    return;
  }
  if (button.dataset.act === "summon") reactToPost(postId);
}

function onFeedSubmit(event) {
  const form = event.target.closest("form.comment-box");
  if (!form || !feedEl.contains(form)) return;
  event.preventDefault();
  const text = form.querySelector("textarea").value.trim();
  if (!text) return;
  const postId = form.dataset.post;
  commit((state) => {
    const post = state.posts.find((item) => item.id === postId);
    if (!post) return;
    post.comments.push({
      id: newId(),
      authorId: ME,
      content: text.slice(0, 300),
      createdAt: new Date().toISOString()
    });
  });
  render();
}

function onFeedKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey) return;
  const textarea = event.target.closest("textarea");
  const form = textarea?.closest("form.comment-box");
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}

function saveProfile() {
  const name = document.querySelector("#profile-name").value.trim() || "我";
  const signature = document.querySelector("#profile-sign").value.trim();
  commit((state) => {
    state.profile.name = name.slice(0, 20);
    state.profile.signature = signature.slice(0, 80);
  });
  render();
}

function openSettings() {
  const state = load();
  document.querySelector("#set-base").value = state.settings.baseUrl;
  document.querySelector("#set-key").value = state.settings.apiKey;
  document.querySelector("#set-model").value = state.settings.model;
  document.querySelector("#set-auto").checked = state.settings.autoReact;
  document.querySelector("#settings").showModal();
}

function saveSettings(event) {
  event.preventDefault();
  commit((state) => {
    state.settings.baseUrl = document.querySelector("#set-base").value.trim();
    state.settings.apiKey = document.querySelector("#set-key").value.trim();
    state.settings.model = document.querySelector("#set-model").value.trim();
    state.settings.autoReact = document.querySelector("#set-auto").checked;
  });
  document.querySelector("#settings").close();
  render();
  toast("接口设置已留在这台浏览器里");
}

async function testApi() {
  const button = document.querySelector("#test-api");
  button.disabled = true;
  try {
    const text = await completeChat({
      baseUrl: document.querySelector("#set-base").value.trim(),
      apiKey: document.querySelector("#set-key").value.trim(),
      model: document.querySelector("#set-model").value.trim(),
      temperature: 0,
      maxTokens: 16,
      messages: [
        { role: "system", content: "只回复 OK 两个字母。" },
        { role: "user", content: "ping" }
      ]
    });
    toast(`连上了：${text.slice(0, 40)}`);
  } catch (err) {
    toast(err.message || "没连上");
  } finally {
    button.disabled = false;
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(load(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const day = new Date().toISOString().slice(0, 10);
  link.href = URL.createObjectURL(blob);
  link.download = `nijika-qzone-export-${day}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || !Array.isArray(parsed.posts)) throw new Error("这不是空间备份");
      if (!window.confirm("用这份备份覆盖现在的空间？")) return;
      const current = load();
      save({
        profile: { ...current.profile, ...(parsed.profile || {}) },
        settings: { ...current.settings, ...(parsed.settings || {}) },
        posts: parsed.posts,
        visits: Array.isArray(parsed.visits) ? parsed.visits : []
      });
      // 再走一遍 load，把缺字段补齐后写回。
      save(load());
      render();
      toast("备份已导入");
    } catch (err) {
      toast(err.message || "导入失败");
    }
  };
  reader.readAsText(file);
}

function bind() {
  document.querySelector("#composer").addEventListener("submit", publishPost);
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      ui.composeKind = button.dataset.kind;
      document.querySelectorAll(".tab").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      render();
    });
  });
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      ui.kindFilter = button.dataset.filter;
      render();
    });
  });

  feedEl.addEventListener("click", onFeedClick);
  feedEl.addEventListener("submit", onFeedSubmit);
  feedEl.addEventListener("keydown", onFeedKeydown);

  document.querySelector("#friend-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const character = findCharacter(button.dataset.friend);
    if (!character) return;
    if (button.dataset.act === "filter") {
      ui.authorFilter = ui.authorFilter === character.id ? null : character.id;
      render();
      return;
    }
    friendPublish(character, button.dataset.act);
  });

  document.querySelector("#profile-name").addEventListener("change", saveProfile);
  document.querySelector("#profile-sign").addEventListener("change", saveProfile);
  document.querySelector("#open-settings").addEventListener("click", openSettings);
  document.querySelector("#settings-form").addEventListener("submit", saveSettings);
  document.querySelector("#close-settings").addEventListener("click", () => {
    document.querySelector("#settings").close();
  });
  document.querySelector("#test-api").addEventListener("click", testApi);
  document.querySelector("#export-data").addEventListener("click", exportData);
  document.querySelector("#import-data").addEventListener("click", () => {
    document.querySelector("#import-file").click();
  });
  document.querySelector("#import-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) importData(file);
  });

  document.querySelector("#call-friend").addEventListener("change", (event) => {
    commit((state) => {
      state.settings.autoReact = event.target.checked;
    });
  });
}

// 第一次打开时把欢迎说说写进 localStorage，刷新后时间不会变。
save(load());
bind();
render();
