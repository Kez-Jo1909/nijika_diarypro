// 空间写在项目的 data/space.json。localStorage 只用来把旧数据搬过去一次。

const STORAGE_KEY = "nijika-qzone-v1";
let memory = null;
let writing = false;
let pending = false;

function welcomePost(now) {
  return {
    id: "welcome-nijika",
    authorId: "nijika",
    kind: "shuoshuo",
    title: "",
    content: "沙发我先坐了。你要是写下今天的事，我会来留言的。练习刚结束，好想吃一口冰淇淋。",
    createdAt: now,
    likes: [],
    comments: []
  };
}

export function defaultState() {
  const now = new Date().toISOString();
  return {
    profile: {
      name: "Kez",
      signature: "今天也想好好记下一点什么。",
      avatar: ""
    },
    avatars: {},
    settings: {
      baseUrl: "",
      apiKey: "",
      model: "",
      autoReact: true
    },
    posts: [welcomePost(now)],
    visits: []
  };
}

function normalizeComment(comment) {
  return {
    id: comment.id || newId(),
    authorId: comment.authorId || "me",
    content: comment.content || "",
    createdAt: comment.createdAt || new Date().toISOString()
  };
}

function normalizePost(post) {
  return {
    id: post.id || newId(),
    authorId: post.authorId || "me",
    kind: post.kind === "diary" ? "diary" : "shuoshuo",
    title: post.title || "",
    content: post.content || "",
    createdAt: post.createdAt || new Date().toISOString(),
    likes: Array.isArray(post.likes) ? post.likes.filter((id) => typeof id === "string") : [],
    comments: Array.isArray(post.comments) ? post.comments.map(normalizeComment) : []
  };
}

function normalize(parsed) {
  const base = defaultState();
  if (!parsed || typeof parsed !== "object") return base;
  return {
    profile: { ...base.profile, ...(parsed.profile || {}) },
    settings: { ...base.settings, ...(parsed.settings || {}) },
    avatars: parsed.avatars && typeof parsed.avatars === "object" ? parsed.avatars : {},
    posts: (Array.isArray(parsed.posts) ? parsed.posts : base.posts).map(normalizePost),
    visits: Array.isArray(parsed.visits) ? parsed.visits.slice(0, 30) : []
  };
}

export function load() {
  if (!memory) memory = defaultState();
  return memory;
}

async function persist(snapshot) {
  const response = await fetch("/api/space", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot)
  });
  if (!response.ok) throw new Error("没能写到 data/space.json");
}

function queueSave() {
  pending = true;
  if (writing) return;
  writing = true;
  const flush = async () => {
    try {
      while (pending) {
        const snapshot = JSON.parse(JSON.stringify(memory));
        pending = false;
        await persist(snapshot);
      }
    } catch (err) {
      console.warn(err);
      window.dispatchEvent(new CustomEvent("space-save-error"));
    } finally {
      writing = false;
      if (pending) queueSave();
    }
  };
  flush();
}

export function save(state) {
  memory = state;
  queueSave();
}

export async function hydrate() {
  let fromFile = null;
  try {
    const response = await fetch("/api/space");
    if (response.ok) fromFile = await response.json();
  } catch (err) {
    console.warn("读取 data/space.json 失败", err);
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  const fromBrowser = raw ? normalize(JSON.parse(raw)) : null;

  if (fromFile && Array.isArray(fromFile.posts)) {
    memory = normalize(fromFile);
    // 文件可能是另一台浏览器先写出来的，密钥还在当前浏览器里时补上。
    if (fromBrowser && !memory.settings.apiKey && fromBrowser.settings.apiKey) {
      memory.settings = { ...memory.settings, ...fromBrowser.settings };
      if (fromBrowser.posts.length > memory.posts.length) memory.posts = fromBrowser.posts;
      queueSave();
    }
    if (fromBrowser) localStorage.removeItem(STORAGE_KEY);
    return { migrated: Boolean(fromBrowser && fromBrowser.settings.apiKey) };
  }

  if (fromBrowser) {
    memory = fromBrowser;
    queueSave();
    localStorage.removeItem(STORAGE_KEY);
    return { migrated: true };
  }

  memory = defaultState();
  queueSave();
  return { migrated: false };
}

// 读-改-写放在同一次同步调用里，避免请求回来时盖掉刚点的赞。
export function commit(mutator) {
  const state = load();
  mutator(state);
  save(state);
  return state;
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
