import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    /* `/api` 转发到本机 uvicorn。**proxy 只存在于 dev**：测与部署都由 FastAPI
       托管 `dist/`，同一个 origin，同一份字节（简报 §1.4）。

       没有这一段时 `bun run dev` 打不开产品路径：`main.tsx` 的围栏把无 query
       的默认路由指向 ProductApp，而它第一件事就是打同源的 `/api/sessions`，
       vite dev server 上没有这条路由也没有转发——于是「开发时看投放链路」
       这件事只能改用先 build 再起 uvicorn 的 e2e 那套。

       刻意**不装 CORS**：同源部署下根本没有跨域，配 CORS 只会在开发期把
       「proxy 写错了」一路掩盖到生产。 */
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});
