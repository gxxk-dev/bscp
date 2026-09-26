/* ===========================================================================
   入口。
   ===========================================================================
   这一版还只有演示路径。`App.tsx` 刚改名为 `DemoApp`（git mv，保留历史），
   这里跟着改 import 就够了——这一步是无行为变化的重构，用冒烟全绿证明
   行为没动。产品路径与 `?path=` 围栏是下一个提交的事。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DemoApp from "./DemoApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
