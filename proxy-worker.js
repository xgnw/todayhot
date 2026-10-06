/**
 * 热榜 CORS 代理 · Cloudflare Worker
 * --------------------------------------------------------------
 * 为什么需要它：
 *   微博 / 百度 / B站 / uapis.cn 等接口都不返回 Access-Control-Allow-Origin，
 *   浏览器遵循同源策略会直接丢弃响应 —— 这正是原版必须用 PHP curl 抓取的原因。
 *   本 Worker 代为请求并把响应加上跨域头返回，于是纯静态 HTML 也能实时更新。
 *
 * 部署：
 *   1. Cloudflare Dashboard → Workers 和 Pages → 创建 Worker
 *   2. 粘贴本文件全部内容 → 部署
 *   3. 把Worker地址复制保存，然后在"设置 - 代理前缀"中填入：
 *      https://<你的>.workers.dev/?url=
 *   4. 控制台页面：进入 页面 → "运行&分享"
 *
 * 安全（重要）：
 *   默认开启了域名白名单，只允许本页需要的热榜域名。
 *   若要放行任意域名，把 ALLOW_ANY 改成 true —— 但那样你的 Worker 就变成了
 *   可被任何人滥用的开放代理，可能被人拿来刷流量导致封号，不建议。
 */

// ============ 配置区 ============
const ALLOW_ANY = false;          // true = 允许代理任意网址（有滥用风险）
const TIMEOUT_MS = 15000;          // 单次请求超时
const MAX_BYTES = 2 * 1024 * 1024; // 单次响应体上限 2MB

// 域名白名单：命中其中任一项（后缀匹配）即放行
const ALLOW_HOSTS = [
  'weibo.com', 's.weibo.com',
  'baidu.com', 'top.baidu.com',
  'bilibili.com', 'api.bilibili.com',
  'toutiao.com', 'www.toutiao.com',
  'douyin.com', 'iesdouyin.com', 'www.iesdouyin.com',
  'uapis.cn',
  'github.com', 'api.github.com',
  'viki.moe', '60s-api.viki.moe'
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function fail(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function hostAllowed(host) {
  if (ALLOW_ANY) return true;
  return ALLOW_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

async function handleProxy(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return fail('url 参数不是合法地址');
  }
  if (!/^https?:$/.test(u.protocol)) return fail('仅支持 http/https');
  if (!hostAllowed(u.hostname)) return fail(`域名未放行：${u.hostname}`, 403);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });
    clearTimeout(timer);

    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return fail('响应过大', 502);

    const out = new Headers(CORS_HEADERS);
    const ct = upstream.headers.get('content-type');
    out.set('Content-Type', ct && ct.includes('json')
      ? 'application/json; charset=utf-8'
      : (ct || 'text/plain; charset=utf-8'));
    out.set('Cache-Control', 'public, max-age=60');

    return new Response(body, { status: upstream.status, headers: out });
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? '上游请求超时' : String(e && e.message || e);
    return fail('代理失败：' + msg, 502);
  }
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') return fail('仅支持 GET', 405);

    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/') {
      return json({
        ok: true,
        service: 'rebang-cors-proxy',
        tip: '用法：/?url=' + encodeURIComponent('https://weibo.com/ajax/side/hotSearch'),
        allowed_hosts: ALLOW_ANY ? '*' : ALLOW_HOSTS
      });
    }

    const target = url.searchParams.get('url');
    if (!target) return fail('缺少 url 参数，示例：/?url=' + encodeURIComponent('https://uapis.cn/api/v1/misc/hotboard?type=zhihu'));

    return handleProxy(target);
  }
};
