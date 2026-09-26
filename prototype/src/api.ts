/* ===========================================================================
   API：网络往返都在这一层。
   ===========================================================================
   落点计算不在这里——那是 ingest.ts 的纯函数。这一层只做三件事：拼路径、
   发请求、把服务端那个错误信封解成 {@link ApiError}。

   ## 为什么路径一律是相对的 `/api/...`

   写死 `http://localhost:8000`（或读一个 VITE_API_BASE）在 vite proxy 下
   **碰巧能跑**，在 FastAPI 托管构建产物时打错地方，而那正是真机部署形态
   ——只有部署之后才暴露。本地、开发、生产三者共用同一个 origin 与同一份
   字节，proxy 存在的意义是让这三者没有区别，不是让前端能配一个 base。

   也不在前端配 CORS。同源部署下根本没有跨域，配 CORS 只会在开发期把
   「proxy 写错了」这件事一路掩盖到生产。装不装 CORS 中间件是后端的事。

   `assertApiPath` 把这条规矩变成一条会真的抛错的断言：以后谁传进来一个
   绝对 URL，dev 下立刻炸，而不是等到真机。 */
import type {
  AcceptedItem, ArtifactReceipt, RejectedItem, VerdictItem,
} from "./types";

/** 服务端那个错误信封（`server/bscp/errors.py`）。`code` 与 `remedy` 是
    权威的，`message` 只是兜底文案——具体到某一份文件的话由 messages.ts
    按 `code + params` 渲染。 */
export type ErrorEnvelope = {
  code: string;
  message: string;
  detail: string;
  remedy: string;
  retryable: boolean;
  [k: string]: unknown;
};

/** 客户端自己的码。`server_unreachable` 服务端**故意不用**：那会儿压根没
    拿到响应，让它和「服务端崩了」共用一个码会把两条不同的出路混掉。 */
export const CLIENT_CODES = {
  unreachable: "server_unreachable",
  notJson: "response_not_json",
} as const;

export class ApiError extends Error {
  readonly code: string;
  /** 比 `message` 更细的一句，给「为什么」用；`message` 是给操作者看的那句。 */
  readonly detail: string;
  readonly remedy: string;
  readonly retryable: boolean;
  readonly status: number;
  /** 信封里除那五个固定字段之外的键（`limit` / `pixels` / `traceId` …）。 */
  readonly params: Record<string, unknown>;

  constructor(e: ErrorEnvelope & { status: number }) {
    super(e.message);
    this.name = "ApiError";
    this.code = e.code;
    this.detail = e.detail;
    this.remedy = e.remedy;
    this.retryable = e.retryable;
    this.status = e.status;
    this.params = {};
    for (const [k, v] of Object.entries(e)) {
      if (!RESERVED.has(k)) this.params[k] = v;
    }
  }

  /** 会话没了（410 家族）。这四种的处理动作是同一个：重新开始。 */
  get isGone(): boolean {
    return this.status === 410;
  }
}

/** 信封里那五个固定字段，不进 `params`。 */
const RESERVED = new Set(["code", "message", "detail", "remedy", "retryable", "status"]);

function assertApiPath(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error(`API 路径必须是以 /api/ 开头的相对路径，收到：${path}`);
  }
  return path;
}

/** 读错误信封。**绝不让 `res.json()` 的异常逃出去**：拿到 HTML 时它抛
    SyntaxError，而那正是 spec 明令禁止的白屏（服务端有 `/api/*` 的 JSON
    兜底，但前端不能把「万一」当保障）。 */
async function envelope(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new ApiError({
      code: CLIENT_CODES.notJson,
      message: "服务端回的不是 JSON（通常是它没起来，或者前面挂了代理）。",
      detail: `HTTP ${res.status} ${res.statusText}，content-type: ${res.headers.get("content-type") ?? "空"}`,
      remedy: "retry",
      retryable: true,
      status: res.status,
    });
  }
  const e = (body as { error?: ErrorEnvelope } | null)?.error;
  if (!e || typeof e.code !== "string") {
    return new ApiError({
      code: CLIENT_CODES.notJson,
      message: "服务端的错误信封缺字段。",
      detail: JSON.stringify(body).slice(0, 200),
      remedy: "retry",
      retryable: true,
      status: res.status,
    });
  }
  return new ApiError({ ...e, status: res.status });
}

/** 一次 JSON 往返。`fetch` 自己就失败时给一个**客户端**码，不假装是服务端的。 */
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw notJson(res, cause);
  }
}

/** 发出去，把传输层的两种失败收敛成 ApiError。 */
async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(assertApiPath(path), {
      ...init,
      cache: "no-store",
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_CODES.unreachable,
      message: "连不上服务端。",
      detail: cause instanceof Error ? cause.message : String(cause),
      remedy: "retry",
      retryable: true,
      status: 0,
    });
  }
  if (!res.ok) throw await envelope(res);
  return res;
}

/** 响应不是可解析的 JSON。这是「白屏」的直接来源（`res.json()` 抛
    SyntaxError，而 spec 把那个白屏列为禁止状态），所以必须在这里就
    变成一个操作者看得懂的 ApiError。 */
function notJson(res: Response, cause: unknown): ApiError {
  return new ApiError({
    code: CLIENT_CODES.notJson,
    message: "服务端的响应读不懂（通常是它没起来，或者前面挂了代理）。",
    detail: `HTTP ${res.status} ${res.statusText}，content-type: ${
      res.headers.get("content-type") ?? "空"}；${
      cause instanceof Error ? cause.message : String(cause)}`,
    remedy: "retry",
    retryable: true,
    status: res.status,
  });
}

/** 建会话。**懒建**：第一次投放时才建，打开页面不烧一个 30 分钟的会话。 */
export function createSession(signal?: AbortSignal): Promise<{ sessionId: string; expiresAt: string }> {
  return json("/api/sessions", { method: "POST", signal });
}

/** 用完就走。「重新开始」调它：页位图只在服务端内存里，前端不留任何副本
    （ADR-0014），所以本地的块在会话没了之后就是几张空壳。 */
export function deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  return json<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    signal,
  });
}

/** 一次投放的客户端键。**同名文件是合法的**，只有这个键能把回执对回
    自己那一个 `File`——服务端在 multipart 里拿不回 part 名，所以走一个
    平行字段。 */
export function clientKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 一次要发出去的一份。键由调用方起，**不是**这里起的：
    拖拽路径要在过闸门**之前**就给每份文件起好键，本地拒掉的那些才排得进
    同一条回执的原始顺序里（见 ingest.ts 的 `gateFile`）。 */
export type Outgoing = { file: File; key: string };

export type UploadOutcome = { receipt: ArtifactReceipt; byKey: Map<string, VerdictItem> };

/** 投放。**端点恒 200**：混着收与拒靠 `items[]` 逐项表达。
    所以这里只有网络层与 410/413/5xx 会抛，闸门的答案是数据不是异常。 */
export async function uploadArtifacts(
  sessionId: string,
  outgoing: Outgoing[],
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const fd = new FormData();
  for (const o of outgoing) fd.append("files", o.file, o.file.name);
  fd.append("clientKeys", JSON.stringify(outgoing.map((o) => o.key)));

  const receipt = await json<ArtifactReceipt>(
    `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    { method: "POST", body: fd, signal },
  );
  /* 顺序即回执顺序，但**按 clientKey 索引**而不是按下标：服务端在
     clientKeys 长度对不上时会退回下标，那时这份 map 的键就是下标字符串，
     两种情形都用同一段代码兜住。 */
  const byKey = new Map<string, VerdictItem>();
  for (const item of receipt.items) byKey.set(item.clientKey, item);
  return { receipt, byKey };
}

/** 区域位图。返回原始字节，**不**在这里物化成 object URL——那是
    RegionImage 的缓存该管的事，这一层只负责一次往返。 */
export function fetchRegionBitmap(path: string, signal?: AbortSignal): Promise<Blob> {
  /* 路径是服务端回执里的 `bitmapUrl`，本身就是相对路径（sessions.py 的
     bitmap_url）。仍然过 assertApiPath：万一服务端哪天改成绝对 URL，
     这里要炸在开发期而不是在投屏时白屏。 */
  return fetch(assertApiPath(path), { cache: "no-store", signal }).then(async (res) => {
    if (!res.ok) throw await envelope(res);
    return await res.blob();
  });
}

export type { AcceptedItem, RejectedItem, VerdictItem, ArtifactReceipt };
