/* NP Worker entry (Cloudflare Workers with static assets).
   /api/* runs the NP backend; everything else is the static site. No scheduled handler: nothing runs unless someone visits. */
import { onRequest } from '../functions/api/[[path]].js';
export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return onRequest({ request, env, params:{}, waitUntil:p => ctx.waitUntil(p) });
    return env.ASSETS.fetch(request);
  }
};
