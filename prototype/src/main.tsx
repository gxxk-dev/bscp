/* ===========================================================================
   入口：一条围栏决定「演示」还是「产品」。
   ===========================================================================
   `?path=` 存在 → DemoApp（12 条行为路径的评审脚手架），否则 → ProductApp。

   为什么用**存在性**而不是一个白名单：评审脚手架里的顶部导航、PROTOTYPE
   红标、提示条，全都是「投屏时记得藏起来」就会漏的东西。产品路径下它们
   根本不存在——靠不存在来保证，比靠每次都记得藏可靠（DemoApp 文件头也是
   这么写的）。

   围栏判的是「有没有这个 query 参数」，不判它的值。所以 `?path=`
   与 `?path=drop&step=1` 都进演示，而正常打开（空 query）进产品。
   少写一个 `?` 就是另一个人。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DemoApp from "./DemoApp";
import ProductApp from "./ProductApp";
import "./index.css";

const demo = new URLSearchParams(location.search).has("path");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {demo ? <DemoApp /> : <ProductApp />}
  </StrictMode>,
);
