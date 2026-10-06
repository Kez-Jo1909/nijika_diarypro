// 全部动态都在这台浏览器的 localStorage 里。
// 没有账号服务器；换浏览器或清站点数据会丢，所以页面里可以导出 JSON。

const STORAGE_KEY = "nijika-qzone-v1";

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

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return {
      profile: { ...base.profile, ...(parsed.profile || {}) },
      settings: { ...base.settings, ...(parsed.settings || {}) },
      avatars: parsed.avatars && typeof parsed.avatars === "object" ? parsed.avatars : {},
      posts: (Array.isArray(parsed.posts) ? parsed.posts : base.posts).map(normalizePost),
      visits: Array.isArray(parsed.visits) ? parsed.visits.slice(0, 30) : []
    };
  } catch (err) {
    console.warn("读取本地数据失败，使用空白空间", err);
    return defaultState();
  }
}

export function save(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
