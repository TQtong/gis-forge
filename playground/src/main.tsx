import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

/**
 * 获取 #root 挂载点并启动 React 应用。
 * StrictMode 在开发模式下启用额外检查（双重渲染检测副作用泄漏）。
 */
const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    '[GeoForge DevPlayground] 找不到 #root 挂载点，请检查 index.html 是否包含 <div id="root"></div>',
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
